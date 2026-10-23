"use client";

import { activityIcon } from "@/lib/activity-registry";
import { AttentionPanel } from "./AttentionPanel";
import { EnquiriesPanel } from "./EnquiriesPanel";
import { ChangeTime } from "@/components/ChangeTime";
import { useCallback, useEffect, useState } from "react";
import { addDays, formatHour, todayISO } from "@/lib/time";
import { COUNTER_METHODS, HIRE_CONDITION_LABELS, MAX_DEPOSIT, MAX_HIRE_NOTE, MAX_VENUE_AHEAD_DAYS, PAID_VIA_LABELS } from "@/lib/types";
import type { CounterMethod } from "@/lib/types";
import type { Court, HireCondition } from "@/lib/types";
import type { AdminBookingRow, BookingHit } from "@/lib/store";
import { localTime, todayLocal } from "./shared";
import { money, currencySymbol } from "@/lib/region";

/* ---------------- Bookings tab ---------------- */

const COLUMNS = [
  "Code",
  "Venue",
  "Court",
  "Time",
  "Customer",
  "Phone",
  "Total",
  "Status",
  "Payment",
  "Attendance",
  "Kit",
  "",
];

export function BookingsTab() {
  const [date, setDate] = useState(todayLocal);
  // A customer at the desk asking about a booking: by code, number, email or name.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<BookingHit[] | null>(null);
  // The booking a search led to, picked out in the day's list.
  const [found, setFound] = useState<string | null>(null);
  const [bookings, setBookings] = useState<AdminBookingRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The booking being moved, and the courts it could go to.
  const [moving, setMoving] = useState<{ code: string; courts: Court[] } | null>(null);
  // The booking (or `series:` code) whose payment method is being asked for.
  const [paying, setPaying] = useState<string | null>(null);
  // The booking being changed to another day or time.
  const [changing, setChanging] = useState<AdminBookingRow | null>(null);
  const changeOptionsUrl = useCallback(
    (day: string) => `/api/admin/bookings/reschedule?code=${encodeURIComponent(changing?.code ?? "")}&date=${day}`,
    [changing?.code]
  );
  // The hire being handed over or taken back at the desk.
  const [kit, setKit] = useState<{
    code: string;
    mode: "take" | "return";
    deposit: number;
    courtName: string;
  } | null>(null);
  const [deposit, setDeposit] = useState("0");
  const [condition, setCondition] = useState<HireCondition>("ok");
  const [withheld, setWithheld] = useState("0");
  const [note, setNote] = useState("");
  const [revenue, setRevenue] = useState(0);
  const [collected, setCollected] = useState(0);
  const [outstanding, setOutstanding] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/bookings?date=${date}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setBookings(data.bookings);
      setRevenue(data.revenue);
      setCollected(data.collected);
      setOutstanding(data.outstanding);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setBookings(null);
    } finally {
      setBusy(false);
    }
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  /** Ask which courts this booking could move to, then show the picker. */
  async function openMove(code: string) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/bookings/move?code=${encodeURIComponent(code)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load courts");
      if (data.courts.length === 0) {
        setError(`No other court of the same sport is free for the whole of ${code}.`);
        return;
      }
      setMoving({ code, courts: data.courts });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load courts");
    }
  }

  async function moveTo(code: string, courtId: number) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/bookings/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, courtId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Move failed");
      setNotice(`${code} moved from ${data.from} to ${data.to}. Same code, same price. The customer has been sent the news.`);
      setMoving(null);
      load();
      window.dispatchEvent(new Event("attention:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Move failed");
    }
  }

  function openChange(b: AdminBookingRow) {
    setError(null);
    setNotice(null);
    setMoving(null);
    setChanging(b);
  }

  function openKit(b: AdminBookingRow, mode: "take" | "return") {
    setError(null);
    setNotice(null);
    setKit({
      code: b.code,
      mode,
      deposit: mode === "take" ? b.courtDeposit : (b.hire?.deposit ?? 0),
      courtName: b.courtName,
    });
    setDeposit(String(b.courtDeposit));
    setCondition("ok");
    setWithheld("0");
    setNote("");
  }

  /** Hand the kit over, or take it back and settle the deposit. */
  async function submitKit() {
    if (!kit) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/hire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          kit.mode === "take"
            ? { code: kit.code, action: "take", deposit: Number(deposit) }
            : {
                code: kit.code,
                action: "return",
                condition,
                withheld: Number(withheld),
                note,
              }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not update the hire");
      setNotice(
        kit.mode === "take"
          ? `${kit.courtName} out on ${kit.code}, ${money(data.hire.deposit)} held.`
          : data.hire.withheld > 0
            ? `${kit.code} settled — ${money(data.hire.withheld)} kept back, ${money(data.hire.deposit - data.hire.withheld)} returned.`
            : `${kit.code} settled — ${money(data.hire.deposit)} returned in full.`
      );
      setKit(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the hire");
    }
  }

  async function cancelBooking(code: string) {
    if (!window.confirm(`Cancel booking ${code}? Its slots will be released, and the customer is told.`)) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      load();
      window.dispatchEvent(new Event("attention:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
    }
  }

  async function checkConcession(b: AdminBookingRow, outcome: "seen" | "refused", remember?: string, via?: CounterMethod) {
    setError(null);
    try {
      const res = await fetch("/api/admin/concessions/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: b.id, outcome, remember, via }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not record it");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record it");
    }
  }

  /** The venue's note on this customer (lib/customer-notes.ts): written, changed, or cleared. */
  async function writeNote(b: AdminBookingRow) {
    const note = window.prompt(
      `Note on ${b.name} (${b.phone}), shown on each of their bookings here. Keep it factual: they can ask to see it. Clear it to take it away.`,
      b.staffNote ?? ""
    );
    if (note === null) return;
    setError(null);
    const res = await fetch("/api/admin/customer-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId: b.venueId, phone: b.phone, note }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not save the note");
    load();
  }

  /** The customer signed the venue's waiver on paper at the desk (lib/waivers.ts). */
  async function paperWaiver(b: AdminBookingRow) {
    if (!window.confirm(`Has ${b.name} signed the waiver on paper? It is recorded in your name.`)) return;
    setError(null);
    const res = await fetch("/api/admin/waiver/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: b.id }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Could not record it");
    load();
  }

  /** Onto a company or school account (lib/accounts.ts), or off it again. */
  async function charge(b: AdminBookingRow, accountId: number | null) {
    setError(null);
    const res = await fetch("/api/admin/accounts/charge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: b.id, accountId }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not change its account");
    load();
  }

  async function togglePaid(code: string, paid: boolean, via?: CounterMethod) {
    setError(null);
    setPaying(null);
    if (!paid && !window.confirm(`Mark ${code} unpaid?`)) return;
    try {
      const res = await fetch("/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, paid, via }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Payment update failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment update failed");
    }
  }

  async function toggleCheckIn(code: string, out: boolean) {
    setError(null);
    try {
      const res = await fetch("/api/admin/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, out }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Check-in failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check-in failed");
    }
  }

  /**
   * Stop a number booking this venue online again — somebody filling the
   * evening with bookings nobody plays. Their bookings stay until cancelled.
   */
  async function blockNumber(b: AdminBookingRow) {
    const reason = window.prompt(
      `Stop ${b.phone} booking ${b.venueName} online? They can still call you. Why (optional, only staff see it):`
    );
    if (reason === null) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/venues/${b.venueId}/blocked-phones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: b.phone, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not block the number");
      setNotice(`${b.phone} can no longer book ${b.venueName} online. Undo under Venue details.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not block the number");
    }
  }

  async function forgiveStrikes(b: AdminBookingRow) {
    if (!confirm(`Forgive ${b.phone} their ${b.strikes?.count ?? 0} strike(s) at ${b.venueName}? Only what happens from tomorrow counts again.`))
      return;
    setError(null);
    try {
      const res = await fetch("/api/admin/strikes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId: b.venueId, phone: b.phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not forgive the strikes");
      setNotice(`${b.phone}'s strikes at ${b.venueName} no longer count.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not forgive the strikes");
    }
  }

  async function toggleNoShow(code: string, noShow: boolean) {
    // A no-show can cost the customer: past the venue's strike limit, they pay online to book.
    if (noShow && !confirm(`Mark ${code} as a no-show? If you count strikes (Venues & staff → Cancellations), this counts against their number.`))
      return;
    setError(null);
    try {
      const res = await fetch("/api/admin/no-show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, noShow }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function paySeries(seriesCode: string, via?: CounterMethod) {
    setPaying(null);
    if (!via) {
      // Ask how first, as for one booking.
      setPaying(`series:${seriesCode}`);
      return;
    }
    setError(null);
    try {
      const res = await fetch("/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesCode, via }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Payment update failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment update failed");
    }
  }

  const act: Act = {
    paying,
    setPaying,
    togglePaid,
    toggleCheckIn,
    toggleNoShow,
    openKit,
    openMove,
    openChange,
    cancelBooking,
    paySeries,
    blockNumber,
    forgiveStrikes,
    checkConcession,
    charge,
    writeNote,
    paperWaiver,
  };

  return (
    <div className="space-y-4">
      <AttentionPanel />
      <EnquiriesPanel />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (query.trim().length < 3) return setHits(null);
          const res = await fetch(`/api/admin/bookings?q=${encodeURIComponent(query.trim())}`, { cache: "no-store" });
          setHits(res.ok ? ((await res.json()).hits as BookingHit[]) : []);
        }}
      >
        <input
          type="search"
          aria-label="Find a booking"
          placeholder="Find a booking: code, phone, email or name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value === "") setHits(null);
          }}
          className="min-h-10 w-80 max-w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <button type="submit" className="min-h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:border-teal-500">
          Find
        </button>
      </form>
      {hits && (
        <div className="rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
          {hits.length === 0 ? (
            <p className="px-4 py-3 text-slate-500">No booking 90 days either side of today matches that.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {hits.map((h) => (
                <li key={h.code}>
                  <button
                    type="button"
                    onClick={() => {
                      setDate(h.date);
                      setFound(h.code);
                      setHits(null);
                    }}
                    className="flex w-full flex-wrap gap-x-3 px-4 py-2 text-left hover:bg-teal-50"
                  >
                    <span className="font-mono font-semibold">{h.code}</span>
                    <span>
                      {h.date} {formatHour(h.startHour)}–{formatHour(h.endHour)}
                    </span>
                    <span className="text-slate-600">
                      {h.courtName}, {h.venueName}
                    </span>
                    <span>{h.name}</span>
                    <span className="text-slate-500">{h.phone}</span>
                    <span className={h.status === "cancelled" ? "text-red-600" : h.paymentStatus === "paid" ? "text-emerald-700" : "text-amber-700"}>
                      {h.status === "cancelled" ? "Cancelled" : h.paymentStatus === "paid" ? "Paid" : "Unpaid"}
                    </span>
                  </button>
                </li>
              ))}
              {hits.length >= 50 && <li className="px-4 py-2 text-xs text-slate-500">The 50 nearest the end of the range; type more to narrow it down.</li>}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-slate-600">
          <span className="sr-only">Day to show</span>
          <input
            type="date"
            aria-label="Day to show"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="min-h-10 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
        {bookings && (
          <>
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm shadow-sm">
              <span className="text-slate-500">Bookings:</span>{" "}
              <span className="font-bold">{bookings.length}</span>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm shadow-sm">
              <span className="text-slate-500">Expected:</span>{" "}
              <span className="font-bold text-teal-700">{money(revenue)}</span>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm shadow-sm">
              <span className="text-emerald-700">Collected:</span>{" "}
              <span className="font-bold text-emerald-700">{money(collected)}</span>
            </div>
            <div
              className={`rounded-lg border px-4 py-1.5 text-sm shadow-sm ${
                outstanding > 0
                  ? "border-amber-200 bg-amber-50 text-amber-700"
                  : "border-slate-200 bg-white text-slate-500"
              }`}
            >
              <span>Outstanding:</span>{" "}
              <span className="font-bold">{money(outstanding)}</span>
            </div>
          </>
        )}
      </div>

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {moving && (
        <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
          <p className="text-sm font-semibold">
            Move {moving.code} to which court?
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            The code, the price and any payment or check-in stay exactly as they are. Only courts
            free for the whole booking are listed.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {moving.courts.map((c) => (
              <button
                key={c.id}
                onClick={() => moveTo(moving.code, c.id)}
                className="rounded-lg border border-teal-300 bg-white px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-100"
              >
                {c.name}
              </button>
            ))}
            <button
              onClick={() => setMoving(null)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {changing && (
        <ChangeTime
          key={changing.code}
          booking={changing}
          staff
          lastDate={addDays(todayISO(), MAX_VENUE_AHEAD_DAYS)}
          optionsUrl={changeOptionsUrl}
          submit={(o, day) =>
            fetch("/api/admin/bookings/reschedule", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: changing.code, date: day, start: o.startMin, courtId: o.courtId }),
            })
          }
          onDone={(booking) => {
            setChanging(null);
            setNotice(
              `${booking.code} is now ${booking.date}, ${formatHour(booking.startHour)}–${formatHour(booking.endHour)}. Same code; ${
                booking.paymentStatus === "paid" ? "the price stays as paid" : `${money(booking.totalPrice.toFixed(2))} to pay`
              }. The customer has been sent the news.`
            );
            load();
            window.dispatchEvent(new Event("attention:refresh"));
          }}
          onClose={() => setChanging(null)}
        />
      )}

      {kit && kit.mode === "take" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <p className="text-sm font-semibold">
            Hand {kit.courtName} over on {kit.code}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            Take the deposit at the desk and hold it until the kit comes back. This also checks the
            customer in.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium text-slate-600">Deposit held ({currencySymbol()})</label>
            <input
              type="number"
            step={0.01}
              min={0}
              max={MAX_DEPOSIT}
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
              className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
            />
            <button
              onClick={submitKit}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
            >
              Hand over
            </button>
            <button
              onClick={() => setKit(null)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {kit && kit.mode === "return" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <p className="text-sm font-semibold">
            Take {kit.courtName} back in on {kit.code}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            {money(kit.deposit)} is held. Anything kept back needs a note saying why — the customer is
            about to be told.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600">Condition</label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as HireCondition)}
                className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
              >
                {Object.entries(HIRE_CONDITION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Kept back ({currencySymbol()})</label>
              <input
                type="number"
            step={0.01}
                min={0}
                max={kit.deposit}
                value={withheld}
                onChange={(e) => setWithheld(e.target.value)}
                className="mt-1 w-24 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
              />
            </div>
            <div className="min-w-[16rem] flex-1">
              <label className="block text-xs font-medium text-slate-600">
                What happened{condition === "ok" && withheld === "0" ? " (optional)" : ""}
              </label>
              <input
                value={note}
                maxLength={MAX_HIRE_NOTE}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Cracked hull near the bow seat"
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
              />
            </div>
            <button
              onClick={submitKit}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
            >
              Take back
            </button>
            <button
              onClick={() => setKit(null)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {busy && !bookings ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          Loading…
        </div>
      ) : bookings && bookings.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          No bookings on {date}.
        </div>
      ) : bookings ? (
        <>
          {/* A counter runs on a phone as often as a screen. Below `lg` the
              same bookings are a list of cards, because a twelve-column table
              on a 390px screen means scrolling sideways to find the button you
              press the most. */}
          <ul className="space-y-3 lg:hidden">
            {bookings.map((b) => (
              <li
                key={b.id}
                className={`rounded-xl border bg-white p-4 shadow-sm ${b.code === found ? "border-teal-500 ring-2 ring-teal-200" : "border-slate-200"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <span className="font-mono font-semibold text-teal-700">{b.code}</span>
                    <SeriesChip b={b} act={act} />
                    <div className="mt-0.5 text-sm font-medium">
                      {activityIcon(b.sport)} {b.courtName}
                    </div>
                    <div className="text-sm text-slate-500">
                      {formatHour(b.startHour)} – {formatHour(b.endHour)} · {b.venueName}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">{money(b.totalPrice)}</div>
                    {b.status !== "confirmed" && (
                      <span className="text-xs font-semibold text-slate-400">{b.releasedUnpaid ? "released (unpaid)" : b.status}</span>
                    )}
                  </div>
                </div>

                <div className="mt-2 text-sm">
                  {b.name}
                  <NoShowBadge b={b} />
                  <StrikesBadge b={b} act={act} />
                  <a href={`tel:${b.phone}`} className="ml-2 text-slate-500 underline">
                    {b.phone}
                  </a>
                  <CheckedPhone b={b} />
                  <Extras b={b} act={act} />
                  <StaffNote b={b} act={act} />
                  <WaiverChip b={b} act={act} />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <PaymentChip b={b} act={act} />
                  <AccountChip b={b} act={act} />
                  <AttendanceChip b={b} act={act} />
                  <KitChip b={b} act={act} />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <RowActions b={b} act={act} />
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm lg:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  {COLUMNS.map((label, i) => (
                    <th key={i} className="px-3 py-2 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id} className={`border-b border-slate-100 last:border-0 ${b.code === found ? "bg-teal-50" : ""}`}>
                    <td className="px-3 py-2 font-mono font-medium text-teal-700">
                      {b.code}
                      <SeriesChip b={b} act={act} />
                    </td>
                    <td className="px-3 py-2">{b.venueName}</td>
                    <td className="px-3 py-2">
                      {activityIcon(b.sport)} {b.courtName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatHour(b.startHour)} – {formatHour(b.endHour)}
                    </td>
                    <td className="px-3 py-2">
                      {b.name}
                      <NoShowBadge b={b} />
                  <StrikesBadge b={b} act={act} />
                      <Extras b={b} act={act} />
                      <StaffNote b={b} act={act} />
                      <WaiverChip b={b} act={act} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {b.phone}
                      <CheckedPhone b={b} />
                    </td>
                    <td className="px-3 py-2 font-medium">{money(b.totalPrice)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          b.status === "confirmed"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {b.releasedUnpaid ? "released (unpaid)" : b.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <PaymentChip b={b} act={act} />
                      <AccountChip b={b} act={act} />
                    </td>
                    <td className="px-3 py-2">
                      <AttendanceChip b={b} act={act} />
                    </td>
                    <td className="px-3 py-2">
                      <KitChip b={b} act={act} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <RowActions b={b} act={act} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The controls on one booking, written once.
 *
 * A booking appears twice — as a table row on a wide screen and as a card on a
 * narrow one — and the two must never drift. Only the layout differs; every
 * button below is the same button.
 */
interface Act {
  paying: string | null;
  setPaying: (key: string | null) => void;
  togglePaid: (code: string, paid: boolean, via?: CounterMethod) => void;
  toggleCheckIn: (code: string, out: boolean) => void;
  toggleNoShow: (code: string, noShow: boolean) => void;
  openKit: (b: AdminBookingRow, mode: "take" | "return") => void;
  openMove: (code: string) => void;
  openChange: (b: AdminBookingRow) => void;
  cancelBooking: (code: string) => void;
  paySeries: (seriesCode: string, via?: CounterMethod) => void;
  blockNumber: (b: AdminBookingRow) => void;
  forgiveStrikes: (b: AdminBookingRow) => void;
  checkConcession: (b: AdminBookingRow, outcome: "seen" | "refused", remember?: string, via?: CounterMethod) => void;
  charge: (b: AdminBookingRow, accountId: number | null) => void;
  writeNote: (b: AdminBookingRow) => void;
  paperWaiver: (b: AdminBookingRow) => void;
}

const CHIP = "inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-semibold transition";

function SeriesChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (!b.seriesCode) return null;
  return (
    <button
      onClick={() => act.paySeries(b.seriesCode!)}
      title={`Mark all unpaid sessions in ${b.seriesCode} as paid`}
      className="ml-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded-full bg-violet-50 text-[10px] font-semibold text-violet-700 hover:bg-violet-100"
    >
      🔁
    </button>
  );
}

/** Booked from an account that proved, with a code sent to it, that this number is theirs. */
function CheckedPhone({ b }: { b: AdminBookingRow }) {
  if (!b.phoneChecked) return null;
  return (
    <span title="Number checked: the customer proved it is theirs" className="ml-1 text-xs font-semibold text-emerald-700">
      ✓
    </span>
  );
}

/** The venue's note on this customer, or a way to write one. */
function StaffNote({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (!b.staffNote)
    return (
      <button type="button" onClick={() => act.writeNote(b)} className="ml-1 text-xs text-slate-400 hover:text-teal-700" title="Write a note on this customer">
        📝
      </button>
    );
  return (
    <button
      type="button"
      onClick={() => act.writeNote(b)}
      title="Change the note"
      className="mt-1 block max-w-xs rounded bg-amber-50 px-2 py-0.5 text-left text-xs text-amber-900 ring-1 ring-amber-200"
    >
      📝 {b.staffNote}
    </button>
  );
}

/** Not yet agreed to the venue's waiver: to sign at the desk. Nothing where it is signed, or asked for none. */
function WaiverChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (b.waiverSigned || b.status !== "confirmed") return null;
  return (
    <button
      type="button"
      onClick={() => act.paperWaiver(b)}
      title="Has not agreed to your waiver. Click once they have signed it on paper."
      className="mt-1 block rounded bg-rose-50 px-2 py-0.5 text-left text-xs font-medium text-rose-800 ring-1 ring-rose-200"
    >
      ✍ No waiver yet: signed on paper?
    </button>
  );
}

/** Rackets, shuttles or drinks to hand over with the booking. */
function Extras({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (!b.addons?.length)
    return (
      <>
        {(b.players ?? 1) > 1 && <div className="mt-1 text-xs text-slate-600">👥 {b.players} players</div>}
        {b.coachName && <Coach b={b} />}
        <ConcessionCheck b={b} act={act} />
      </>
    );
  return (
    <div className="mt-1 text-xs text-slate-600">
      {b.coachName && <Coach b={b} />}
      {(b.players ?? 1) > 1 && <div>👥 {b.players} players</div>}
      🎒 {b.addons.map((a) => `${a.quantity} × ${a.name}${a.kind === "rental" ? " (hire)" : ""}`).join(", ")}
      <ConcessionCheck b={b} act={act} />
    </div>
  );
}

/**
 * A concession price (lib/concessions.ts): look at the proof and say so. Seen,
 * it can be remembered for a while; not shown, the full price is charged. The
 * proof itself is never kept, only that it was seen.
 */
function ConcessionCheck({ b, act }: { b: AdminBookingRow; act: Act }) {
  const [step, setStep] = useState<"seen" | "refused" | null>(null);
  if (!b.concessionName || !b.concessionCheck) return null;
  const off = money(b.concessionOff ?? 0);
  if (b.concessionCheck === "seen") return <div className="mt-1 text-xs text-emerald-700">🎫 {b.concessionName} price · proof seen</div>;
  if (b.concessionCheck === "refused") return <div className="mt-1 text-xs text-slate-500">🎫 No {b.concessionName} proof: full price</div>;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-amber-800">
      <span title="Look at the proof: nothing is photographed or kept, only that you saw it.">
        🎫 {b.concessionName} price ({off} off): check proof
      </span>
      {b.status === "confirmed" && step === null && (
        <>
          <button onClick={() => setStep("seen")} className={`${CHIP} bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200`}>
            Proof seen
          </button>
          <button onClick={() => setStep("refused")} className={`${CHIP} bg-amber-50 text-amber-800 ring-1 ring-amber-200`}>
            No proof
          </button>
        </>
      )}
      {step === "seen" && (
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="text-slate-500">Don&apos;t ask again until</span>
          {(
            [
              ["visit", "next visit"],
              ["month", "month end"],
              ["year", "year end"],
              ["twelve", "12 months"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => act.checkConcession(b, "seen", value)}
              className={`${CHIP} bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200`}
            >
              {label}
            </button>
          ))}
          <button onClick={() => setStep(null)} aria-label="Cancel" className="px-1 text-slate-400">
            ✕
          </button>
        </span>
      )}
      {step === "refused" &&
        (b.paymentStatus === "paid" ? (
          <MethodPicker label={`Take ${off} more by`} onPick={(via) => act.checkConcession(b, "refused", undefined, via)} onCancel={() => setStep(null)} />
        ) : (
          <span className="inline-flex items-center gap-1">
            <button onClick={() => act.checkConcession(b, "refused")} className={`${CHIP} bg-amber-600 text-white`}>
              Charge full price (+{off})
            </button>
            <button onClick={() => setStep(null)} aria-label="Cancel" className="px-1 text-slate-400">
              ✕
            </button>
          </span>
        ))}
    </div>
  );
}

/** A lesson: the coach, and their fee inside the price. */
function Coach({ b }: { b: AdminBookingRow }) {
  return (
    <div className="mt-1 text-xs text-indigo-700">
      🎓 Lesson with {b.coachName} ({money(b.coachFee ?? 0)} of it the coach&apos;s)
    </div>
  );
}

/** Strikes against this number here, where the venue counts them, with a way to let them off. */
function StrikesBadge({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (!b.strikes || b.strikes.count === 0) return null;
  const out = b.strikes.count >= b.strikes.limit;
  return (
    <button
      onClick={() => act.forgiveStrikes(b)}
      title={`${b.strikes.count} of ${b.strikes.limit} strikes here${out ? ": must pay online to book" : ""}. Click to forgive.`}
      className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${out ? "bg-red-600 text-white" : "bg-amber-100 text-amber-800"}`}
    >
      {b.strikes.count}/{b.strikes.limit} strikes
    </button>
  );
}

function NoShowBadge({ b }: { b: AdminBookingRow }) {
  if (b.priorNoShows === 0) return null;
  return (
    <span
      title={`${b.priorNoShows} previous no-show${b.priorNoShows > 1 ? "s" : ""}`}
      className="ml-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600"
    >
      ⚠ {b.priorNoShows}
    </span>
  );
}

function PaymentChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (b.status !== "confirmed") return <span className="text-xs text-slate-400">—</span>;
  // Held for payment online: it goes by itself if not paid in time.
  if (b.paymentStatus === "unpaid" && b.holdUntil)
    return (
      <span
        title="The customer is paying online. Not paid by then, the booking is let go."
        className={`${CHIP} bg-amber-50 text-amber-700 ring-1 ring-amber-200`}
      >
        held till {localTime(b.holdUntil)}
      </span>
    );
  // Nothing to take: a free court (a condominium's, say) owes nothing.
  if (b.totalPrice === 0 && b.paymentStatus !== "paid")
    return <span className={`${CHIP} bg-slate-100 text-slate-500`}>free</span>;
  const paid = b.paymentStatus === "paid";
  // The money is in the venue's gateway account, not the till: undoing it is
  // a refund there, not a click here.
  if (paid && b.paidOnline)
    return (
      <span
        title="Paid online, into the venue's payment account. Refund it there if it has to go back."
        className={`${CHIP} bg-emerald-100 text-emerald-700`}
      >
        ✓ online
      </span>
    );
  const asking = act.paying === b.code || (b.seriesCode !== null && act.paying === `series:${b.seriesCode}`);
  if (!paid && asking) {
    const series = act.paying !== b.code;
    return <MethodPicker
      label={series ? `Series ${b.seriesCode} paid by` : "Paid by"}
      onPick={(via) => (series ? act.paySeries(b.seriesCode!, via) : act.togglePaid(b.code, true, via))}
      onCancel={() => act.setPaying(null)}
    />;
  }
  return (
    <button
      onClick={() => (paid ? act.togglePaid(b.code, false) : act.setPaying(b.code))}
      title={
        ((b.depositPaid ?? 0) > 0 ? `${money(b.depositPaid ?? 0)} deposit paid online. ` : "") +
        (b.sharesPaid - (b.depositPaid ?? 0) > 0 ? `${money(b.sharesPaid - (b.depositPaid ?? 0))} paid online by other players or friends. ` : "") +
        (paid ? `${b.paidVia ? `${PAID_VIA_LABELS[b.paidVia]}. ` : ""}Click to mark unpaid` : "Click to mark paid")
      }
      className={`${CHIP} ${
        paid
          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          : "bg-amber-100 text-amber-700 hover:bg-amber-200"
      }`}
    >
      {paid
        ? `✓ ${b.paidVia ? SHORT_VIA[b.paidVia] : "paid"}`
        : b.sharesPaid > 0
          ? `${money(b.totalPrice - b.sharesPaid)} due`
          : "unpaid"}
    </button>
  );
}

/**
 * Charged to a company or school account: which, and whether it is on an
 * invoice yet. An unpaid booking can be put on one here, or taken off until invoiced.
 */
function AccountChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  const [choices, setChoices] = useState<{ id: number; name: string }[] | null>(null);
  if (b.status !== "confirmed") return null;
  if (b.accountName)
    return (
      <span className={`${CHIP} mt-1 gap-1 bg-sky-50 text-sky-800 ring-1 ring-sky-200`} title="Paid on the account's monthly invoice">
        🏢 {b.accountName}
        {b.invoiced ? " · invoiced" : ""}
        {!b.invoiced && b.paymentStatus === "unpaid" && (
          <button type="button" aria-label="Take it off the account" onClick={() => act.charge(b, null)} className="text-sky-500 hover:text-red-600">
            ×
          </button>
        )}
      </span>
    );
  if (b.paymentStatus !== "unpaid" || b.totalPrice === 0) return null;
  if (choices === null)
    return (
      <button
        type="button"
        onClick={async () => {
          const res = await fetch(`/api/admin/accounts?venueId=${b.venueId}`, { cache: "no-store" });
          setChoices(res.ok ? (await res.json()).accounts : []);
        }}
        className="mt-1 block text-xs text-slate-500 underline hover:text-teal-700"
      >
        on account…
      </button>
    );
  if (choices.length === 0) return <span className="mt-1 block text-xs text-slate-400">No accounts here</span>;
  return (
    <select
      aria-label="Charge to an account"
      defaultValue=""
      onChange={(e) => e.target.value && act.charge(b, Number(e.target.value))}
      className="mt-1 block rounded-md border border-slate-300 px-1 py-0.5 text-xs"
    >
      <option value="">Charge to…</option>
      {choices.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

const SHORT_VIA: Record<NonNullable<AdminBookingRow["paidVia"]>, string> = {
  cash: "cash",
  qr: "QR",
  transfer: "transfer",
  card: "card",
  online: "online",
  pass: "pass",
  credit: "credit",
};

/** How the desk took the money: one tap each, so the till and the bank can be reconciled later. */
function MethodPicker({
  label,
  onPick,
  onCancel,
}: {
  label: string;
  onPick: (via: CounterMethod) => void;
  onCancel: () => void;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-xs text-slate-500">{label}</span>
      {COUNTER_METHODS.map((m) => (
        <button
          key={m}
          onClick={() => onPick(m)}
          title={PAID_VIA_LABELS[m]}
          className={`${CHIP} bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100`}
        >
          {SHORT_VIA[m]}
        </button>
      ))}
      <button onClick={onCancel} aria-label="Cancel" className="px-1 text-xs text-slate-400 hover:text-slate-600">
        ✕
      </button>
    </span>
  );
}

function AttendanceChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (b.status !== "confirmed") return <span className="text-xs text-slate-400">—</span>;
  if (b.checkedInAt)
    return (
      <button
        onClick={() => act.toggleCheckIn(b.code, !b.checkedOutAt)}
        title={
          b.checkedOutAt
            ? `Left at ${localTime(b.checkedOutAt)}`
            : `Arrived ${localTime(b.checkedInAt)} — click to check out`
        }
        className={`${CHIP} ${
          b.checkedOutAt
            ? "bg-slate-100 text-slate-500"
            : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
        }`}
      >
        {b.checkedOutAt ? `left ${localTime(b.checkedOutAt)}` : `in ${localTime(b.checkedInAt)}`}
      </button>
    );
  return (
    <span className="inline-flex gap-1">
      <button
        onClick={() => act.toggleCheckIn(b.code, false)}
        title="Check the customer in at the desk"
        className={`${CHIP} bg-teal-50 text-teal-700 hover:bg-teal-100`}
      >
        check in
      </button>
      <button
        onClick={() => act.toggleNoShow(b.code, !b.noShow)}
        title={b.noShow ? "Click to clear the no-show" : "Mark the customer as a no-show"}
        className={`${CHIP} ${
          b.noShow
            ? "bg-red-100 text-red-700 hover:bg-red-200"
            : "bg-slate-100 text-slate-500 hover:bg-slate-200"
        }`}
      >
        {b.noShow ? "no-show" : "no-show?"}
      </button>
    </span>
  );
}

function KitChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (b.hire === null && (b.courtDeposit === 0 || b.status !== "confirmed")) return null;
  if (b.hire === null)
    return (
      <button
        onClick={() => act.openKit(b, "take")}
        title={`Hand ${b.courtName} over against an ${money(b.courtDeposit)} deposit`}
        className={`${CHIP} bg-amber-50 text-amber-700 hover:bg-amber-100`}
      >
        hand out
      </button>
    );
  if (b.hire.returnedAt === null)
    return (
      <button
        onClick={() => act.openKit(b, "return")}
        title={`Out since ${localTime(b.hire.takenAt)}, ${money(b.hire.deposit)} held — click to take it back`}
        className={`${CHIP} bg-amber-100 text-amber-800 hover:bg-amber-200`}
      >
        out · {money(b.hire.deposit)}
      </button>
    );
  return (
    <span
      title={
        (b.hire.note ?? "No note.") + (b.hire.withheld ? ` ${money(b.hire.withheld)} kept back.` : "")
      }
      className={`${CHIP} ${
        b.hire.condition === "ok" ? "bg-slate-100 text-slate-500" : "bg-red-100 text-red-700"
      }`}
    >
      {b.hire.condition === "ok"
        ? "back"
        : `${HIRE_CONDITION_LABELS[b.hire.condition!].toLowerCase()}${
            b.hire.withheld ? ` · ${money(b.hire.withheld)}` : ""
          }`}
    </span>
  );
}

function RowActions({ b, act }: { b: AdminBookingRow; act: Act }) {
  if (b.status !== "confirmed") return null;
  return (
    <>
      <button
        onClick={() => act.openMove(b.code)}
        title="Put this booking on another court, keeping its code and payment"
        className="inline-flex min-h-7 items-center rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
      >
        Move
      </button>
      {b.classId === null && !b.checkedInAt && (
        <button
          onClick={() => act.openChange(b)}
          title="Move this booking to another day or time, keeping its code and payment"
          className="inline-flex min-h-7 items-center rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
        >
          Change time
        </button>
      )}
      <button
        onClick={() => act.cancelBooking(b.code)}
        className="inline-flex min-h-7 items-center rounded-md border border-red-300 px-2.5 text-xs font-medium text-red-600 hover:bg-red-50"
      >
        Cancel
      </button>
      <button
        onClick={() => act.blockNumber(b)}
        title="Stop this phone number booking online"
        className="inline-flex min-h-7 items-center rounded-md px-2 text-xs text-slate-400 hover:text-red-600"
      >
        Block number
      </button>
    </>
  );
}
