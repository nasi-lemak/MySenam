"use client";

import { readJson } from "@/lib/read-response";
import { activityIcon } from "@/lib/activity-registry";
import { ReceiptsPanel } from "./ReceiptsPanel";
import { VouchersPanel } from "./VouchersPanel";
import { CounterSalesPanel } from "./CounterSalesPanel";
import { AccountsPanel } from "./AccountsPanel";
import { useCallback, useEffect, useState } from "react";
import { MAX_HOURS_PER_BOOKING, MAX_MEMBERSHIP_COVERS, MAX_PASS_ENTRIES, MAX_PASS_MINUTES, MAX_PROMO_AMOUNT, MAX_PROMO_PERCENT, MAX_TOP_UP } from "@/lib/types";
import type { BenefitScope, Membership, Pass, PromoCode, WalletEntry } from "@/lib/types";
import type { OfferedFor } from "@/lib/membership-plans";
import { ParticipantPicker, type PickedParticipant } from "./ParticipantPicker";
import { MembershipCovers } from "./MembershipCovers";
import { MembershipSuspension } from "./MembershipSuspension";
import { todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { money, region } from "@/lib/region";
import { sportLabel } from "@/lib/i18n";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

/* ---------------- Credit tab ---------------- */

interface WalletCustomer {
  id: number;
  name: string;
  email: string;
  phone: string;
  balance: number;
}

export function CreditTab({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cr.lookupFailed")));
      setScope(data.scope);
      setCustomer(data.customer);
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cr.lookupFailed"));
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cr.topUpFailed")));
      setNotice(t("cr.added", { amount: money(amount), balance: money(data.balance) }));
      setCustomer({ ...customer, balance: data.balance });
      setEntries([data.entry, ...entries]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cr.topUpFailed"));
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-6">
      <div className="max-w-2xl space-y-4">
      <p className="text-sm text-slate-600">
        {t("cr.intro")}
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
            aria-label={t("cr.venueCounter")}
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
          placeholder={t("cr.findPlaceholder")} aria-label={t("cr.findPlaceholder")}
          className={`w-64 ${inputClass}`}
        />
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          {t("cr.find")}
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
                  {t("cr.spendableAt", { venue: venues.find((v) => v.id === creditVenueId)?.name ?? t("cr.thisVenue") })}
                </div>
              )}
            </div>
          </div>
          {scope === "venue" && (
            <p className="mt-2 text-xs text-slate-500">
              {t("cr.venueCredit")}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("cr.topUpField")}
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
              {t("cr.addCredit")}
            </button>
          </div>

          {entries.length > 0 && (
            <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100 pt-2 text-sm">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-slate-600">{t.say(entry.reasonPhrase, entry.reason)}</span>
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

      <AccountsPanel venues={venues} />

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
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [passes, setPasses] = useState<Pass[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: t("cr.passDefaultName"),
    sport: "",
    kind: "session" as "session" | "time",
    entries: "10",
    entryMinutes: "60",
    maxMinutes: "",
    price: "120",
    holderName: "",
    holderPhone: "",
    accountEmail: "",
    expiresOn: "",
    coachId: "",
    // What one use covers (lib/entitlements.ts): the booking, a resource hired whole, one person's place, each place.
    scope: "booking" as BenefitScope,
  });
  // A pass for one person's place, held for a participant the holder acts for; null: the holder themself.
  const [passFor, setPassFor] = useState<PickedParticipant | null>(null);
  const [coaches, setCoaches] = useState<{ id: number; name: string; active: boolean }[]>([]);

  const venue = venues.find((v) => v.id === venueId) ?? null;
  const sports = [...new Set((venue?.courts ?? []).map((c) => c.sport))];

  const load = useCallback(async () => {
    if (!venueId) return;
    const [res, c] = await Promise.all([
      fetch(`/api/admin/passes?venueId=${venueId}`, { cache: "no-store" }),
      fetch(`/api/admin/coaches?venueId=${venueId}`, { cache: "no-store" }).catch(() => null),
    ]);
    if (c?.ok) setCoaches(((await readJson(c)).coaches ?? []).filter((x: { active: boolean }) => x.active));
    if (!res.ok) return;
    const data = await readJson(res);
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
          kind: form.kind,
          // A time pass is sold in hours here, kept in minutes.
          entries: form.kind === "time" ? Math.round(Number(form.entries) * 60) : Number(form.entries),
          entryMinutes: form.kind === "time" || form.entryMinutes.trim() === "" ? null : Number(form.entryMinutes),
          maxMinutes: form.maxMinutes.trim() === "" ? null : Number(form.maxMinutes),
          price: Number(form.price),
          holderName: form.holderName,
          holderPhone: form.holderPhone,
          accountEmail: form.accountEmail.trim() || undefined,
          expiresOn: form.expiresOn,
          coachId: form.coachId ? Number(form.coachId) : null,
          scope: form.scope,
          ...(form.scope === "participant" && passFor ? { holderParticipantId: passFor.id } : {}),
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cr.passIssueFailed")));
      setNotice(t("cr.passSold", { code: data.pass.code, name: data.pass.holderParticipantName ?? data.pass.holderName }));
      setForm({ ...form, holderName: "", holderPhone: "", accountEmail: "" });
      setPassFor(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cr.passIssueFailed"));
    }
  }

  async function cancel(pass: Pass) {
    if (!confirm(t("cr.passCancelConfirm", { code: pass.code }))) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/passes/${pass.id}/void`, { method: "POST" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cr.passCancelFailed")));
      setNotice(t("cr.passCancelled", { code: pass.code }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cr.passCancelFailed"));
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">{t("cr.passesTitle")}</h2>
      <p className="mt-1 text-sm text-slate-600">
        {t("cr.passesIntro")}
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
            {t("c.venue")}
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
          {t("cr.passName")}
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`mt-1 w-56 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.sport")}
          <select
            value={form.sport}
            onChange={(e) => setForm({ ...form, sport: e.target.value })}
            className={`mt-1 w-40 ${inputClass}`}
          >
            <option value="">{t("cr.anySport")}</option>
            {sports.map((sp) => (
              <option key={sp} value={sp}>
                {activityIcon(sp)} {sportLabel(t.customer, sp)}
              </option>
            ))}
          </select>
        </label>
        {coaches.length > 0 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("cr.for")}
            <select
              value={form.coachId}
              onChange={(e) => setForm({ ...form, coachId: e.target.value })}
              className={`mt-1 w-48 ${inputClass}`}
            >
              <option value="">{t("cr.courtTime")}</option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>
                  {t("cr.lessonsWith", { name: c.name })}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.spends")}
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as "session" | "time" })}
            className={`mt-1 w-40 ${inputClass}`}
          >
            <option value="session">{t("cr.entries")}</option>
            <option value="time">{t("cr.courtTime")}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("ent.cr.covers")}
          <select
            value={form.scope}
            onChange={(e) => setForm({ ...form, scope: e.target.value as BenefitScope })}
            className={`mt-1 w-56 ${inputClass}`}
          >
            <option value="booking">{t("ent.cr.scopeBooking")}</option>
            <option value="resource">{t("ent.cr.scopeResource")}</option>
            <option value="participant">{t("ent.cr.scopeParticipant")}</option>
            <option value="places">{t("ent.cr.scopePlaces")}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {form.kind === "time" ? t("cr.hoursOfCourtTime") : t("cr.entries")}
          <input
            type="number"
            min={form.kind === "time" ? 0.25 : 1}
            step={form.kind === "time" ? 0.25 : 1}
            max={form.kind === "time" ? MAX_PASS_MINUTES / 60 : MAX_PASS_ENTRIES}
            required
            value={form.entries}
            onChange={(e) => setForm({ ...form, entries: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        {form.kind === "session" && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("cr.entryCovers")}
            <input
              type="number"
              min={1}
              max={1440}
              placeholder={t("cr.wholeBooking")}
              value={form.entryMinutes}
              onChange={(e) => setForm({ ...form, entryMinutes: e.target.value })}
              className={`mt-1 w-32 ${inputClass}`}
            />
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.longestBooking")}
          <input
            type="number"
            min={1}
            max={1440}
            placeholder={t("cr.any")}
            value={form.maxMinutes}
            onChange={(e) => setForm({ ...form, maxMinutes: e.target.value })}
            className={`mt-1 w-28 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.price")}
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
          {t("cr.holder")}
          <input
            required
            placeholder={t("c.name")}
            value={form.holderName}
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
            className={`mt-1 w-40 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("c.phone")}
          <input
            required
            placeholder={region().phone.example}
            value={form.holderPhone}
            onChange={(e) => setForm({ ...form, holderPhone: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.expires")}
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
          {t("cr.accountEmail")}
          <input
            type="email"
            placeholder="they@example.com"
            value={form.accountEmail}
            onChange={(e) => setForm({ ...form, accountEmail: e.target.value })}
            className={`mt-1 w-48 ${inputClass}`}
          />
        </label>
        {form.scope === "participant" && venueId > 0 && (
          <div className="w-full text-xs font-medium text-slate-500">
            {t("ent.cr.passFor")}
            <ParticipantPicker venueId={venueId} phone={form.holderPhone} guardianName={form.holderName} value={passFor} onChange={setPassFor} />
          </div>
        )}
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          {t("cr.sellPass")}
        </button>
      </form>

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">{t("cr.code")}</th>
              <th className="px-3 py-2">{t("cr.pass")}</th>
              <th className="px-3 py-2">{t("cr.holder")}</th>
              <th className="px-3 py-2">{t("cr.left")}</th>
              <th className="px-3 py-2">{t("cr.expires")}</th>
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
                    {pass.sport ? activityIcon(pass.sport) : t("cr.allSports")}
                    {pass.coachName && ` · ${t("cr.passLessonsWith", { name: pass.coachName })}`}
                    {pass.scope && pass.scope !== "booking" && ` · ${scopeLabel(t, pass.scope)}`}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {pass.holderName}
                  {pass.holderParticipantName && <span className="block text-xs text-slate-600">{t("ent.cr.forName", { name: pass.holderParticipantName })}</span>}
                  <span className="block text-xs text-slate-400">{pass.holderPhone}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="font-semibold">{pass.remaining}</span>
                  <span className="text-slate-400">
                    {" "}
                    {pass.kind === "time"
                      ? t("cr.ofMinutes", { total: pass.entries })
                      : pass.entryMinutes
                        ? t("cr.ofEntriesOf", { total: pass.entries, minutes: pass.entryMinutes })
                        : t("cr.ofBookings", { total: pass.entries })}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">{pass.expiresOn}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {pass.unusableReason ? (
                    <span className="text-xs text-slate-400">{t.say(pass.unusablePhrase, pass.unusableReason)}</span>
                  ) : (
                    <button
                      onClick={() => cancel(pass)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      {t("c.cancel")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {passes.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  {t("cr.noPasses")}
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
  const t = useStaffT();
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
    // Not with a concession price unless said (lib/discounts.ts).
    combinable: false,
  });
  // Whether a concession price and a code go together at this venue: never (one discount at a time), or where the code allows.
  const [stacking, setStacking] = useState<"never" | "promotion">("never");

  const venue = venues.find((v) => v.id === venueId) ?? null;
  const sports = [...new Set((venue?.courts ?? []).map((c) => c.sport))];

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/promos?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await readJson(res);
    setPromos(data.promos);
    setStacking(data.stacking === "promotion" ? "promotion" : "never");
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
          combinable: form.combinable,
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cr.promoCreateFailed")));
      setNotice(t("cr.promoLive", { code: data.promo.code }));
      setForm({ ...form, code: "", description: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cr.promoCreateFailed"));
    }
  }

  async function saveStacking(value: "never" | "promotion") {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/promos/stacking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, stacking: value }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("stk.stackingFailed")));
      setStacking(data.stacking);
      setNotice(t("stk.stackingSaved", { rule: t(data.stacking === "promotion" ? "stk.stackingPromotion" : "stk.stackingNever") }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stk.stackingFailed"));
    }
  }

  async function withdraw(promo: PromoCode) {
    if (!window.confirm(t("cr.promoWithdrawConfirm", { code: promo.code }))) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/promos/${promo.id}/void`, { method: "POST" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cr.promoWithdrawFailed")));
      setNotice(t("cr.promoWithdrawn", { code: promo.code }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cr.promoWithdrawFailed"));
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">{t("cr.promosTitle")}</h2>
      <p className="mt-1 text-sm text-slate-600">
        {t("cr.promosIntro")}
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
            {t("c.venue")}
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
          {t("cr.code")}
          <input
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            placeholder="RAYA20"
            className={`mt-1 w-32 font-mono ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.promoFor")}
          <input
            required
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t("cr.promoExample")}
            className={`mt-1 w-56 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.type")}
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
            className={`mt-1 w-28 ${inputClass}`}
          >
            <option value="percent">{t("cr.percentOff")}</option>
            <option value="amount">{t("cr.amountOff")}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {form.kind === "percent" ? t("cr.percent") : t("cr.ringgit")}
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
          {t("cr.sport")}
          <select
            value={form.sport}
            onChange={(e) => setForm({ ...form, sport: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          >
            <option value="">{t("cr.anySport")}</option>
            {sports.map((sp) => (
              <option key={sp} value={sp}>
                {activityIcon(sp)} {sportLabel(t.customer, sp)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.minHours")}
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
          {t("c.from")}
          <input
            type="date"
            required
            value={form.validFrom}
            onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("c.until")}
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
          {t("cr.limit")}
          <input
            type="number"
            min={1}
            value={form.maxUses}
            onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
            placeholder="∞"
            title={t("cr.limitHint")}
            className={`mt-1 w-20 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.perCustomer")}
          <input
            type="number"
            min={1}
            value={form.maxPerCustomer}
            onChange={(e) => setForm({ ...form, maxPerCustomer: e.target.value })}
            placeholder="∞"
            title={t("cr.perCustomerHint")}
            className={`mt-1 w-20 ${inputClass}`}
          />
        </label>
        <label className="flex items-center gap-1.5 self-center text-xs font-medium text-slate-500" title={t("stk.combinableHint")}>
          <input
            type="checkbox"
            checked={form.combinable}
            onChange={(e) => setForm({ ...form, combinable: e.target.checked })}
            className="accent-teal-600"
          />
          {t("stk.combinable")}
        </label>
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          {t("cr.createCode")}
        </button>
      </form>

      <div className="mt-3 text-xs text-slate-600">
        <label className="flex flex-wrap items-center gap-2 font-medium">
          {t("stk.stacking")}
          <select
            value={stacking}
            onChange={(e) => saveStacking(e.target.value === "promotion" ? "promotion" : "never")}
            className={inputClass}
          >
            <option value="never">{t("stk.stackingNever")}</option>
            <option value="promotion">{t("stk.stackingPromotion")}</option>
          </select>
        </label>
        <p className="mt-1 text-slate-500">{t("stk.stackingNote")}</p>
      </div>

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">{t("cr.code")}</th>
              <th className="px-3 py-2">{t("cr.promoFor")}</th>
              <th className="px-3 py-2">{t("cr.takesOff")}</th>
              <th className="px-3 py-2">{t("cr.used")}</th>
              <th className="px-3 py-2">{t("cr.runs")}</th>
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
                    {p.sport ? activityIcon(p.sport) : t("cr.allSports")}
                    {p.minHours > 1 ? ` · ${t("cr.minHoursShort", { n: p.minHours })}` : ""}
                    {p.combinable ? ` · ${t("stk.combinableChip")}` : ""}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-semibold">
                  {p.kind === "percent" ? `${p.value}%` : `${money(p.value)}`}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {p.used}
                  <span className="text-slate-400"> / {p.maxUses ?? "∞"}</span>
                  {p.maxPerCustomer !== null && <span className="block text-xs text-slate-400">{t("cr.perCustomerCount", { n: p.maxPerCustomer })}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                  {p.validFrom} → {p.validTo}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {p.unusableReason ? (
                    <span className="text-xs text-slate-400">{t.say(p.unusablePhrase, p.unusableReason)}</span>
                  ) : (
                    <button
                      onClick={() => withdraw(p)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      {t("cr.withdraw")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {promos.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  {t("cr.noPromos")}
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
  const t = useStaffT();
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
    tierId: "",
  });
  // Whose it is (a participant the holder acts for, or the holder themself), and the dependants a family one names.
  const [memberFor, setMemberFor] = useState<PickedParticipant | null>(null);
  const [covers, setCovers] = useState<PickedParticipant[]>([]);
  const [coverPick, setCoverPick] = useState<PickedParticipant | null>(null);
  // The venue's plans, to put a membership sold here on one for its benefits.
  const [tiers, setTiers] = useState<Plan[]>([]);

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/memberships?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await readJson(res);
    setMembers(data.memberships);
    const plans = await fetch(`/api/admin/membership-plans?venueId=${venueId}`, { cache: "no-store" });
    if (plans.ok) setTiers((await readJson(plans)).plans);
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
          ...(form.tierId ? { tierId: Number(form.tierId) } : {}),
          ...(memberFor ? { holderParticipantId: memberFor.id } : {}),
          ...(covers.length > 0 ? { covers: covers.map((c) => c.id) } : {}),
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cr.memberSellFailed")));
      setNotice(t("cr.memberSold", { code: data.membership.code, name: data.membership.holderParticipantName ?? data.membership.holderName }));
      setForm({ ...form, holderName: "", holderPhone: "", accountEmail: "" });
      setMemberFor(null);
      setCovers([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cr.memberSellFailed"));
    }
  }

  /** Days given back: an injury, time away, a long closure. */
  async function extend(m: Membership) {
    const answer = window.prompt(t("cr.extendPrompt", { name: m.holderName, code: m.code, date: m.expiresOn }), "14");
    if (answer === null) return;
    const reason = window.prompt(t("cr.extendReason"), "") ?? "";
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/admin/memberships/${m.id}/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: Number(answer), reason }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("cr.extendFailed")));
    setNotice(t("cr.extended", { code: m.code, date: data.membership.expiresOn }));
    await load();
  }

  async function cancel(m: Membership) {
    if (!window.confirm(t("cr.memberCancelConfirm", { name: m.holderName, code: m.code }))) return;
    // Bought online: the money goes back only where staff say so (lib/payments.ts oweBackMembership).
    const refund = m.online && window.confirm(t("mb6.cr.refundConfirm", { code: m.code }));
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/memberships/${m.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refund }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cr.memberCancelFailed")));
      setNotice(
        typeof data.owedBack === "number"
          ? `${t("cr.memberCancelled", { code: m.code })} ${t("mb6.cr.owedBack", { amount: money(data.owedBack) })}`
          : t("cr.memberCancelled", { code: m.code })
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cr.memberCancelFailed"));
    }
  }

  const intro = t("cr.membershipsIntro").split("{section}");
  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">{t("cr.membershipsTitle")}</h2>
      <p className="mt-1 text-sm text-slate-600">
        {intro[0]}
        <strong>{t("cr.courtsAndRates")}</strong>
        {intro[1]}
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
            {t("c.venue")}
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
          {t("cr.member")}
          <input
            required
            placeholder={t("c.name")}
            value={form.holderName}
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
            className={`mt-1 w-44 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("c.phone")}
          <input
            required
            placeholder={region().phone.example}
            value={form.holderPhone}
            onChange={(e) => setForm({ ...form, holderPhone: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          />
        </label>
        {tiers.length > 0 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("cr.plan")}
            <select
              value={form.tierId}
              onChange={(e) => setForm({ ...form, tierId: e.target.value })}
              className={`mt-1 w-56 ${inputClass}`}
            >
              <option value="">{t("cr.noPlan")}</option>
              {tiers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({tierBenefits(t, p)})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("c.from")}
          <input
            type="date"
            required
            value={form.startsOn}
            onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("c.until")}
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
          {t("cr.fee")}
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
          {t("cr.accountEmail")}
          <input
            type="email"
            placeholder="they@example.com"
            value={form.accountEmail}
            onChange={(e) => setForm({ ...form, accountEmail: e.target.value })}
            className={`mt-1 w-48 ${inputClass}`}
          />
        </label>
        {venueId > 0 && (
          <div className="grid w-full gap-2 text-xs font-medium text-slate-500 sm:grid-cols-2">
            <div>
              {t("ent.cr.memberFor")}
              <ParticipantPicker venueId={venueId} phone={form.holderPhone} guardianName={form.holderName} value={memberFor} onChange={setMemberFor} />
            </div>
            <div>
              {t("ent.cr.alsoCovers")}
              <ParticipantPicker venueId={venueId} phone={form.holderPhone} guardianName={form.holderName} value={coverPick} onChange={setCoverPick} />
              <button
                type="button"
                disabled={!coverPick || covers.some((c) => c.id === coverPick.id) || coverPick.id === memberFor?.id}
                onClick={() => {
                  if (coverPick) setCovers([...covers, coverPick]);
                  setCoverPick(null);
                }}
                className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {t("ent.cr.addCovered")}
              </button>
              {covers.length > 0 && (
                <ul className="mt-1 flex flex-wrap gap-1">
                  {covers.map((c) => (
                    <li key={c.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                      {c.displayName}{" "}
                      <button type="button" onClick={() => setCovers(covers.filter((x) => x.id !== c.id))} aria-label={t("ent.cr.removeCovered", { name: c.displayName })}>
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          {t("cr.sellMembership")}
        </button>
      </form>

      {venueId > 0 && <MembershipPlans venueId={venueId} />}

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[700px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">{t("cr.code")}</th>
              <th className="px-3 py-2">{t("cr.member")}</th>
              <th className="px-3 py-2">{t("cr.runs")}</th>
              <th className="px-3 py-2">{t("cr.feeHeading")}</th>
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
                  <span className="block text-xs text-slate-400">
                    {m.holderPhone}
                    {m.tierName && ` · ${m.tierName}`}
                  </span>
                  {m.holderParticipantName && <span className="block text-xs text-slate-600">{t("ent.cr.forName", { name: m.holderParticipantName })}</span>}
                  {m.covers && m.covers.length > 0 && (
                    <span className="block text-xs text-slate-600">{t("ent.cr.coversNames", { names: m.covers.map((c) => c.name).join(", ") })}</span>
                  )}
                  {m.covers && m.covers.length > 0 && <MembershipCovers membership={m} venueId={venueId} onChanged={load} />}
                  <MembershipSuspension membership={m} onChanged={load} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                  {m.startsOn} → {m.expiresOn}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-semibold">
                  {money(m.price)}
                  {m.online && <span className="ml-1.5 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700">{t("cr.onlineBadge")}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {m.unusableReason ? (
                    <span className="text-xs text-slate-400">{t.say(m.unusablePhrase, m.unusableReason)}</span>
                  ) : (
                    <>
                      <button
                        onClick={() => extend(m)}
                        className="mr-1.5 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        {t("cr.giveDaysBack")}
                      </button>
                      <button
                        onClick={() => cancel(m)}
                        className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        {t("c.cancel")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  {t("cr.noMembers")}
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
  /** A tier's own benefits (lib/membership-plans.ts): this share of the public price, and how far ahead; null: the venue's. */
  ratePercent: number | null;
  aheadDays: number | null;
  /** What the member's price covers: the whole booking its member takes part in, or the members' own places only. */
  scope?: BenefitScope;
  /** Whom customers buy it for online (lib/membership-purchases.ts), and a family plan's limit besides its holder. */
  offeredFor?: OfferedFor;
  familyLimit?: number | null;
  /** A family plan's people put on in place of others per term (none by default; lib/membership-purchases.ts). */
  coverSwaps?: number;
  /** Whether a suspension moves its memberships' end by the days suspended (off by default; lib/membership-suspensions.ts). */
  extendOnSuspension?: boolean;
}

const OFFERED_FOR: OfferedFor[] = ["account", "participant", "individual", "family"];
const OFFERED_FOR_LABELS: Record<OfferedFor, "mbo.cr.forAccount" | "mbo.cr.forParticipant" | "mbo.cr.forIndividual" | "mbo.cr.forFamily"> = {
  account: "mbo.cr.forAccount",
  participant: "mbo.cr.forParticipant",
  individual: "mbo.cr.forIndividual",
  family: "mbo.cr.forFamily",
};
/** A new family plan's limit until a manager chooses another. */
const DEFAULT_FAMILY_LIMIT = 4;

/** What a pass, a concession or a plan's price covers, in a few words (lib/entitlements.ts). */
function scopeLabel(t: StaffT, scope: BenefitScope): string {
  return t(scope === "resource" ? "ent.cr.scopeResource" : scope === "participant" ? "ent.cr.scopeParticipant" : scope === "places" ? "ent.cr.scopePlaces" : "ent.cr.scopeBooking");
}

const RATE_CHOICES = [95, 90, 85, 80, 75, 70, 60, 50];
const AHEAD_CHOICES = [7, 14, 21, 30, 45, 60, 90];

/** What a tier gives, in a few words. */
function tierBenefits(t: StaffT, p: Plan): string {
  const parts = [
    p.ratePercent !== null ? t("cr.tierPays", { percent: p.ratePercent }) : t("cr.tierMemberRates"),
    p.aheadDays !== null ? t("cr.tierBooksAhead", { days: p.aheadDays }) : null,
  ];
  return parts.filter(Boolean).join(", ");
}

/** Membership plans customers can join or renew on online, paid to the venue. */
function MembershipPlans({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [online, setOnline] = useState(true);
  const [form, setForm] = useState({ name: "", months: "12", price: "", ratePercent: "", aheadDays: "" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/membership-plans?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await readJson(res);
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
      body: JSON.stringify({
        venueId,
        name: form.name,
        months: Number(form.months),
        price: Number(form.price),
        ratePercent: form.ratePercent ? Number(form.ratePercent) : null,
        aheadDays: form.aheadDays ? Number(form.aheadDays) : null,
      }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("cr.planAddFailed")));
    setForm({ name: "", months: "12", price: "", ratePercent: "", aheadDays: "" });
    await load();
  }

  async function benefits(
    plan: Plan,
    change: {
      ratePercent?: number | null;
      aheadDays?: number | null;
      scope?: BenefitScope;
      offeredFor?: OfferedFor;
      familyLimit?: number | null;
      coverSwaps?: number;
      extendOnSuspension?: boolean;
    }
  ) {
    setError(null);
    const res = await fetch("/api/admin/membership-plans", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, id: plan.id, ratePercent: plan.ratePercent, aheadDays: plan.aheadDays, ...change }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("cr.planChangeFailed")));
    await load();
  }

  async function retire(plan: Plan) {
    if (!window.confirm(t("cr.planRetireConfirm", { name: plan.name }))) return;
    setError(null);
    const res = await fetch(`/api/admin/membership-plans?venueId=${venueId}&id=${plan.id}`, { method: "DELETE" });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("cr.planRetireFailed")));
    await load();
  }

  const inputClass = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
      <h3 className="font-semibold">{t("cr.plansTitle")}</h3>
      <p className="mt-0.5 text-sm text-slate-600">
        {t("cr.plansIntro")}
      </p>
      {!online && (
        <p className="mt-2 text-sm font-medium text-amber-700">
          {t("cr.plansNotShowing")}
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
                  · {t.plural("cr.months", p.months)} · {money(p.price)}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                  {t("cr.membersPay")}
                  <select aria-label={t("q8b.l.memberRate")}
                    value={p.ratePercent ?? ""}
                    onChange={(e) => benefits(p, { ratePercent: e.target.value === "" ? null : Number(e.target.value) })}
                    className="rounded border border-slate-300 px-1 py-0.5"
                  >
                    <option value="">{t("cr.memberRateOption")}</option>
                    {RATE_CHOICES.map((r) => (
                      <option key={r} value={r}>
                        {t("cr.ofPublicPrice", { percent: r })}
                      </option>
                    ))}
                  </select>
                  {t("cr.andBook")}
                  <select aria-label={t("q8b.l.aheadDays")}
                    value={p.aheadDays ?? ""}
                    onChange={(e) => benefits(p, { aheadDays: e.target.value === "" ? null : Number(e.target.value) })}
                    className="rounded border border-slate-300 px-1 py-0.5"
                  >
                    <option value="">{t("cr.asFarAheadAsMembers")}</option>
                    {AHEAD_CHOICES.map((d) => (
                      <option key={d} value={d}>
                        {t("cr.daysAhead", { days: d })}
                      </option>
                    ))}
                  </select>
                  {t("ent.cr.planScope")}
                  <select aria-label={t("q8b.l.planScope")}
                    value={p.scope ?? "booking"}
                    onChange={(e) => benefits(p, { scope: e.target.value as BenefitScope })}
                    className="rounded border border-slate-300 px-1 py-0.5"
                  >
                    <option value="booking">{t("ent.cr.planScopeBooking")}</option>
                    <option value="participant">{t("ent.cr.planScopeOwn")}</option>
                  </select>
                  {t("mbo.cr.offeredFor")}
                  <select aria-label={t("q8b.l.offeredFor")}
                    value={p.offeredFor ?? "account"}
                    onChange={(e) => {
                      const offeredFor = e.target.value as OfferedFor;
                      benefits(p, { offeredFor, familyLimit: offeredFor === "family" ? (p.familyLimit ?? DEFAULT_FAMILY_LIMIT) : null });
                    }}
                    className="rounded border border-slate-300 px-1 py-0.5"
                  >
                    {OFFERED_FOR.map((f) => (
                      <option key={f} value={f}>
                        {t(OFFERED_FOR_LABELS[f])}
                      </option>
                    ))}
                  </select>
                  {p.offeredFor === "family" && (
                    <select aria-label={t("q8b.l.familyLimit")}
                      value={p.familyLimit ?? DEFAULT_FAMILY_LIMIT}
                      onChange={(e) => benefits(p, { familyLimit: Number(e.target.value) })}
                      className="rounded border border-slate-300 px-1 py-0.5"
                    >
                      {Array.from({ length: MAX_MEMBERSHIP_COVERS }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {t.plural("mbo.cr.upTo", n)}
                        </option>
                      ))}
                    </select>
                  )}
                  {p.offeredFor === "family" && (
                    <select aria-label={t("q8b.l.coverSwaps")}
                      value={p.coverSwaps ?? 0}
                      onChange={(e) => benefits(p, { coverSwaps: Number(e.target.value) })}
                      className="rounded border border-slate-300 px-1 py-0.5"
                    >
                      {Array.from({ length: MAX_MEMBERSHIP_COVERS + 1 }, (_, i) => i).map((n) => (
                        <option key={n} value={n}>
                          {n === 0 ? t("mb6.cr.noSwaps") : t.plural("mb6.cr.swaps", n)}
                        </option>
                      ))}
                    </select>
                  )}
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={p.extendOnSuspension === true}
                      onChange={(e) => benefits(p, { extendOnSuspension: e.target.checked })}
                    />
                    {t("ms7.cr.planExtends")}
                  </label>
                </span>
              </span>
              <button
                onClick={() => retire(p)}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white"
              >
                {t("cr.stopOffering")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.plan")}
          <input
            required
            placeholder={t("cr.planExample")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`mt-1 w-40 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.monthsField")}
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
          {t("cr.fee")}
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
          {t("cr.addPlan")}
        </button>
      </form>
    </div>
  );
}
