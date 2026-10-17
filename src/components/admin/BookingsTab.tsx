"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { HIRE_CONDITION_LABELS, MAX_DEPOSIT, MAX_HIRE_NOTE, SPORT_ICONS } from "@/lib/types";
import type { Court, HireCondition, Venue } from "@/lib/types";
import type { AdminBookingRow } from "@/lib/store";
import { localTime, todayLocal } from "./shared";

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
  const [bookings, setBookings] = useState<AdminBookingRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The booking being moved, and the courts it could go to.
  const [moving, setMoving] = useState<{ code: string; courts: Court[] } | null>(null);
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
      setNotice(`${code} moved from ${data.from} to ${data.to}. Same code, same price.`);
      setMoving(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Move failed");
    }
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
          ? `${kit.courtName} out on ${kit.code}, RM${data.hire.deposit} held.`
          : data.hire.withheld > 0
            ? `${kit.code} settled — RM${data.hire.withheld} kept back, RM${data.hire.deposit - data.hire.withheld} returned.`
            : `${kit.code} settled — RM${data.hire.deposit} returned in full.`
      );
      setKit(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the hire");
    }
  }

  async function cancelBooking(code: string) {
    if (!window.confirm(`Cancel booking ${code}? Its slots will be released.`)) return;
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
    }
  }

  async function togglePaid(code: string, paid: boolean) {
    setError(null);
    try {
      const res = await fetch("/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, paid }),
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

  async function toggleNoShow(code: string, noShow: boolean) {
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

  async function paySeries(seriesCode: string) {
    if (!window.confirm(`Mark all unpaid sessions in series ${seriesCode} as paid?`)) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Payment update failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment update failed");
    }
  }

  const act: Act = {
    togglePaid,
    toggleCheckIn,
    toggleNoShow,
    openKit,
    openMove,
    cancelBooking,
    paySeries,
    blockNumber,
  };

  return (
    <div className="space-y-4">
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
              <span className="font-bold text-teal-700">RM{revenue}</span>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm shadow-sm">
              <span className="text-emerald-700">Collected:</span>{" "}
              <span className="font-bold text-emerald-700">RM{collected}</span>
            </div>
            <div
              className={`rounded-lg border px-4 py-1.5 text-sm shadow-sm ${
                outstanding > 0
                  ? "border-amber-200 bg-amber-50 text-amber-700"
                  : "border-slate-200 bg-white text-slate-500"
              }`}
            >
              <span>Outstanding:</span>{" "}
              <span className="font-bold">RM{outstanding}</span>
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
            <label className="text-xs font-medium text-slate-600">Deposit held (RM)</label>
            <input
              type="number"
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
            RM{kit.deposit} is held. Anything kept back needs a note saying why — the customer is
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
              <label className="block text-xs font-medium text-slate-600">Kept back (RM)</label>
              <input
                type="number"
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
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <span className="font-mono font-semibold text-teal-700">{b.code}</span>
                    <SeriesChip b={b} act={act} />
                    <div className="mt-0.5 text-sm font-medium">
                      {SPORT_ICONS[b.sport]} {b.courtName}
                    </div>
                    <div className="text-sm text-slate-500">
                      {formatHour(b.startHour)} – {formatHour(b.endHour)} · {b.venueName}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">RM{b.totalPrice}</div>
                    {b.status !== "confirmed" && (
                      <span className="text-xs font-semibold text-slate-400">{b.status}</span>
                    )}
                  </div>
                </div>

                <div className="mt-2 text-sm">
                  {b.name}
                  <NoShowBadge b={b} />
                  <a href={`tel:${b.phone}`} className="ml-2 text-slate-500 underline">
                    {b.phone}
                  </a>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <PaymentChip b={b} act={act} />
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
                  <tr key={b.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-mono font-medium text-teal-700">
                      {b.code}
                      <SeriesChip b={b} act={act} />
                    </td>
                    <td className="px-3 py-2">{b.venueName}</td>
                    <td className="px-3 py-2">
                      {SPORT_ICONS[b.sport]} {b.courtName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatHour(b.startHour)} – {formatHour(b.endHour)}
                    </td>
                    <td className="px-3 py-2">
                      {b.name}
                      <NoShowBadge b={b} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{b.phone}</td>
                    <td className="px-3 py-2 font-medium">RM{b.totalPrice}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          b.status === "confirmed"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {b.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <PaymentChip b={b} act={act} />
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
  togglePaid: (code: string, paid: boolean) => void;
  toggleCheckIn: (code: string, out: boolean) => void;
  toggleNoShow: (code: string, noShow: boolean) => void;
  openKit: (b: AdminBookingRow, mode: "take" | "return") => void;
  openMove: (code: string) => void;
  cancelBooking: (code: string) => void;
  paySeries: (seriesCode: string) => void;
  blockNumber: (b: AdminBookingRow) => void;
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
  return (
    <button
      onClick={() => act.togglePaid(b.code, !paid)}
      title={
        (b.sharesPaid > 0 ? `RM${b.sharesPaid} paid online by other players in its open game. ` : "") +
        (paid ? "Click to mark unpaid" : "Click to mark paid")
      }
      className={`${CHIP} ${
        paid
          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          : "bg-amber-100 text-amber-700 hover:bg-amber-200"
      }`}
    >
      {paid ? "✓ paid" : b.sharesPaid > 0 ? `RM${b.totalPrice - b.sharesPaid} due` : "unpaid"}
    </button>
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
        title={`Hand ${b.courtName} over against an RM${b.courtDeposit} deposit`}
        className={`${CHIP} bg-amber-50 text-amber-700 hover:bg-amber-100`}
      >
        hand out
      </button>
    );
  if (b.hire.returnedAt === null)
    return (
      <button
        onClick={() => act.openKit(b, "return")}
        title={`Out since ${localTime(b.hire.takenAt)}, RM${b.hire.deposit} held — click to take it back`}
        className={`${CHIP} bg-amber-100 text-amber-800 hover:bg-amber-200`}
      >
        out · RM{b.hire.deposit}
      </button>
    );
  return (
    <span
      title={
        (b.hire.note ?? "No note.") + (b.hire.withheld ? ` RM${b.hire.withheld} kept back.` : "")
      }
      className={`${CHIP} ${
        b.hire.condition === "ok" ? "bg-slate-100 text-slate-500" : "bg-red-100 text-red-700"
      }`}
    >
      {b.hire.condition === "ok"
        ? "back"
        : `${HIRE_CONDITION_LABELS[b.hire.condition!].toLowerCase()}${
            b.hire.withheld ? ` · RM${b.hire.withheld}` : ""
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
