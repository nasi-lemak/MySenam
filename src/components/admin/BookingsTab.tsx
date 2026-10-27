"use client";

import { activityIcon } from "@/lib/activity-registry";
import { AttentionPanel } from "./AttentionPanel";
import { EnquiriesPanel } from "./EnquiriesPanel";
import { ChangeTime } from "@/components/ChangeTime";
import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, formatHour, todayISO } from "@/lib/time";
import { COUNTER_METHODS, HIRE_CONDITIONS, MAX_DEPOSIT, MAX_HIRE_NOTE, MAX_VENUE_AHEAD_DAYS } from "@/lib/types";
import type { BookingStatus, CounterMethod, PaidVia } from "@/lib/types";
import type { Court, HireCondition } from "@/lib/types";
import type { AdminBookingRow, BookingHit } from "@/lib/store";
import type { DeductionReason, DeductionTreatment } from "@/lib/deposit-deductions";
import type { StaffT } from "@/lib/staff-i18n";
import { localTime, todayLocal } from "./shared";
import { money } from "@/lib/region";
import { isConcessionPreset } from "@/lib/concessions-shared";
import { useStaffT } from "./StaffLanguage";

/* ---------------- Bookings tab ---------------- */

function columns(t: StaffT): string[] {
  return [
    t("bk.col.code"),
    t("c.venue"),
    t("bk.col.court"),
    t("c.time"),
    t("bk.col.customer"),
    t("c.phone"),
    t("c.total"),
    t("c.status"),
    t("bk.col.payment"),
    t("bk.col.attendance"),
    t("bk.col.kit"),
    "",
  ];
}

function conditionLabels(t: StaffT): Record<HireCondition, string> {
  return { ok: t("bk.cond.ok"), damaged: t("bk.cond.damaged"), lost: t("bk.cond.lost") };
}

function statusLabels(t: StaffT): Record<BookingStatus, string> {
  return { confirmed: t("bk.status.confirmed"), cancelled: t("bk.status.cancelled") };
}

export function BookingsTab() {
  const t = useStaffT();
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
  // What is kept back, and why: a line per reason (lib/deposit-deductions.ts).
  const [deductions, setDeductions] = useState<{ reason: DeductionReason; amount: string }[]>([]);
  const [treatments, setTreatments] = useState<DeductionTreatment[]>([]);
  const withheld = deductions.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  const [heldVia, setHeldVia] = useState<"cash" | "qr" | "transfer" | "card">("cash");
  const [note, setNote] = useState("");
  const [revenue, setRevenue] = useState(0);
  const [collected, setCollected] = useState(0);
  const [outstanding, setOutstanding] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The latest day asked for: an answer for a day asked for earlier that arrives later is dropped,
  // so the list never shows one day's bookings under another day's heading.
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/bookings?date=${date}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (mine !== asked.current) return;
      if (!res.ok) throw new Error(t.err(data, t("bk.loadFailed")));
      setBookings(data.bookings);
      setRevenue(data.revenue);
      setCollected(data.collected);
      setOutstanding(data.outstanding);
    } catch (err) {
      if (mine !== asked.current) return;
      setError(err instanceof Error ? err.message : t("bk.loadFailed"));
      setBookings(null);
    } finally {
      if (mine === asked.current) setBusy(false);
    }
  }, [date, t]);

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
      if (!res.ok) throw new Error(t.err(data, t("bk.courtsLoadFailed")));
      if (data.courts.length === 0) {
        setError(t("bk.noOtherCourt", { code }));
        return;
      }
      setMoving({ code, courts: data.courts });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.courtsLoadFailed"));
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
      if (!res.ok) throw new Error(t.err(data, t("bk.moveFailed")));
      setNotice(t("bk.moved", { code, from: data.from, to: data.to }));
      setMoving(null);
      load();
      window.dispatchEvent(new Event("attention:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.moveFailed"));
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
    setDeductions([]);
    setNote("");
    if (mode === "return")
      fetch(`/api/admin/hire?venueId=${b.venueId}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setTreatments(Array.isArray(d.deductions) ? d.deductions : []))
        .catch(() => setTreatments([]));
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
                deductions: deductions.map((d) => ({ reason: d.reason, amount: Number(d.amount) })),
                note,
                via: heldVia,
              }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bk.hireFailed")));
      setNotice(
        kit.mode === "take"
          ? t("bk.kitOut", { kit: kit.courtName, code: kit.code, amount: money(data.hire.deposit) })
          : data.hire.withheld > 0
            ? t("bk.kitSettledKept", {
                code: kit.code,
                kept: money(data.hire.withheld),
                returned: money(data.hire.deposit - data.hire.withheld),
              })
            : t("bk.kitSettledFull", { code: kit.code, amount: money(data.hire.deposit) })
      );
      setKit(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.hireFailed"));
    }
  }

  async function cancelBooking(code: string) {
    if (!window.confirm(t("bk.cancelConfirm", { code }))) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bk.cancelFailed")));
      load();
      window.dispatchEvent(new Event("attention:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.cancelFailed"));
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
      if (!res.ok) throw new Error(t.err(data, t("bk.recordFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.recordFailed"));
    }
  }

  /**
   * One person (or a place nobody is named on) taken off a booking at the
   * counter, the others staying booked (lib/place-withdrawals.ts): in full, on
   * the record. The server says why where it cannot be done.
   */
  async function withdrawPerson(b: AdminBookingRow, placeId: number | null, name: string | null) {
    if (!window.confirm(placeId === null ? t("ent.bk.giveUpConfirm", { code: b.code }) : t("ent.bk.takeOffConfirm", { name: name ?? "?", code: b.code })))
      return;
    const reason = window.prompt(t("ent.bk.reason"), "") ?? "";
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/bookings/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: b.code, ...(placeId === null ? { unnamed: 1 } : { placeId }), reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("ent.bk.takeOffFailed")));
      const w = data.withdrawal as { name: string | null; refund: number; owedLess: number; units: number; price: number };
      setNotice(
        [
          w.name ? t("ent.bk.tookOff", { name: w.name }) : t("ent.bk.gaveUp"),
          w.refund > 0 ? t("ent.bk.refunded", { amount: money(w.refund) }) : w.owedLess > 0 ? t("ent.bk.owedLess", { amount: money(w.owedLess) }) : w.units > 0 ? "" : t("ent.bk.noPrice"),
          w.units > 0 ? t("ent.bk.unitsBack", { n: w.units }) : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ent.bk.takeOffFailed"));
    }
  }

  /** One person's concession on their own place: their proof seen, or not. */
  async function checkPlaceConcession(b: AdminBookingRow, placeBenefitId: number, outcome: "seen" | "refused") {
    setError(null);
    try {
      const res = await fetch("/api/admin/concessions/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: b.id, placeBenefitId, outcome }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bk.recordFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.recordFailed"));
    }
  }

  /** The venue's note on this customer (lib/customer-notes.ts): written, changed, or cleared. */
  async function writeNote(b: AdminBookingRow) {
    const note = window.prompt(t("bk.notePrompt", { name: b.name, phone: b.phone }), b.staffNote ?? "");
    if (note === null) return;
    setError(null);
    const res = await fetch("/api/admin/customer-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId: b.venueId, phone: b.phone, note }),
    });
    const data = await res.json();
    if (!res.ok) setError(t.err(data, t("bk.noteFailed")));
    load();
  }

  /** The customer signed the venue's waiver on paper at the desk (lib/waivers.ts). */
  async function paperWaiver(b: AdminBookingRow) {
    if (!window.confirm(t("bk.waiverConfirm", { name: b.name }))) return;
    setError(null);
    const res = await fetch("/api/admin/waiver/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: b.id }),
    });
    if (!res.ok) setError(t.err(await res.json(), t("bk.recordFailed")));
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
    if (!res.ok) setError(t.err(data, t("bk.accountFailed")));
    load();
  }

  async function togglePaid(code: string, paid: boolean, via?: CounterMethod) {
    setError(null);
    setPaying(null);
    if (!paid && !window.confirm(t("bk.unpaidConfirm", { code }))) return;
    try {
      const res = await fetch("/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, paid, via }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bk.paymentFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.paymentFailed"));
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
      if (!res.ok) throw new Error(t.err(data, t("bk.checkInFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.checkInFailed"));
    }
  }

  /**
   * Stop a number booking this venue online again — somebody filling the
   * evening with bookings nobody plays. Their bookings stay until cancelled.
   */
  async function blockNumber(b: AdminBookingRow) {
    const reason = window.prompt(t("bk.blockPrompt", { phone: b.phone, venue: b.venueName }));
    if (reason === null) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/venues/${b.venueId}/blocked-phones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: b.phone, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bk.blockFailed")));
      setNotice(t("bk.blocked", { phone: b.phone, venue: b.venueName }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.blockFailed"));
    }
  }

  async function forgiveStrikes(b: AdminBookingRow) {
    if (!confirm(t("bk.forgiveConfirm", { phone: b.phone, count: b.strikes?.count ?? 0, venue: b.venueName }))) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/strikes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId: b.venueId, phone: b.phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bk.forgiveFailed")));
      setNotice(t("bk.forgiven", { phone: b.phone, venue: b.venueName }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.forgiveFailed"));
    }
  }

  /** One person a booking names arrived, did not, or clear it (lib/store.ts `markPlace`). */
  async function markPerson(code: string, placeId: number, mark: "arrived" | "no_show" | "clear") {
    setError(null);
    try {
      const res = await fetch("/api/admin/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, placeId, mark }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bk.checkInFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.checkInFailed"));
    }
  }

  async function toggleNoShow(code: string, noShow: boolean) {
    // A no-show can cost the customer: past the venue's strike limit, they pay online to book.
    if (noShow && !confirm(t("bk.noShowConfirm", { code }))) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/no-show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, noShow }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("bk.updateFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.updateFailed"));
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
      if (!res.ok) throw new Error(t.err(data, t("bk.paymentFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.paymentFailed"));
    }
  }

  const act: Act = {
    paying,
    setPaying,
    togglePaid,
    toggleCheckIn,
    toggleNoShow,
    markPerson,
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
    withdrawPerson,
    checkPlaceConcession,
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
          aria-label={t("bk.find")}
          placeholder={t("bk.findPlaceholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value === "") setHits(null);
          }}
          className="min-h-10 w-80 max-w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <button type="submit" className="min-h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:border-teal-500">
          {t("bk.findButton")}
        </button>
      </form>
      {hits && (
        <div className="rounded-lg border border-slate-200 bg-white text-sm shadow-sm">
          {hits.length === 0 ? (
            <p className="px-4 py-3 text-slate-500">{t("bk.noHits")}</p>
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
                      {h.status === "cancelled" ? t("bk.hitCancelled") : h.paymentStatus === "paid" ? t("c.paid") : t("c.unpaid")}
                    </span>
                  </button>
                </li>
              ))}
              {hits.length >= 50 && <li className="px-4 py-2 text-xs text-slate-500">{t("bk.hitsCapped")}</li>}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-slate-600">
          <span className="sr-only">{t("bk.dayToShow")}</span>
          <input
            type="date"
            aria-label={t("bk.dayToShow")}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="min-h-10 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
        {bookings && (
          <>
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm shadow-sm">
              <span className="text-slate-500">{t("bk.count")}</span>{" "}
              <span className="font-bold">{bookings.length}</span>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm shadow-sm">
              <span className="text-slate-500">{t("bk.expected")}</span>{" "}
              <span className="font-bold text-teal-700">{money(revenue)}</span>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm shadow-sm">
              <span className="text-emerald-700">{t("bk.collected")}</span>{" "}
              <span className="font-bold text-emerald-700">{money(collected)}</span>
            </div>
            <div
              className={`rounded-lg border px-4 py-1.5 text-sm shadow-sm ${
                outstanding > 0
                  ? "border-amber-200 bg-amber-50 text-amber-700"
                  : "border-slate-200 bg-white text-slate-500"
              }`}
            >
              <span>{t("bk.outstanding")}</span>{" "}
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
          <p className="text-sm font-semibold">{t("bk.moveWhich", { code: moving.code })}</p>
          <p className="mt-0.5 text-xs text-slate-600">{t("bk.moveHelp")}</p>
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
              {t("c.cancel")}
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
          preview={(o, day) =>
            fetch("/api/admin/bookings/reschedule", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: changing.code, date: day, start: o.startMin, courtId: o.courtId, preview: true }),
            })
          }
          submit={(o, day, reason) =>
            fetch("/api/admin/bookings/reschedule", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: changing.code, date: day, start: o.startMin, courtId: o.courtId, ...(reason ? { reason } : {}) }),
            })
          }
          onDone={(booking) => {
            setChanging(null);
            const when = { code: booking.code, date: booking.date, time: `${formatHour(booking.startHour)}–${formatHour(booking.endHour)}` };
            setNotice(
              booking.paymentStatus === "paid"
                ? t("bk.changedPaid", when)
                : t("bk.changedToPay", { ...when, amount: money(booking.totalPrice.toFixed(2)) })
            );
            load();
            window.dispatchEvent(new Event("attention:refresh"));
          }}
          onClose={() => setChanging(null)}
        />
      )}

      {kit && kit.mode === "take" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <p className="text-sm font-semibold">{t("bk.handOverTitle", { kit: kit.courtName, code: kit.code })}</p>
          <p className="mt-0.5 text-xs text-slate-600">{t("bk.handOverHelp")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium text-slate-600">{t("bk.depositHeld")}</label>
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
              {t("bk.handOver")}
            </button>
            <button
              onClick={() => setKit(null)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              {t("c.cancel")}
            </button>
          </div>
        </div>
      )}

      {kit && kit.mode === "return" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <p className="text-sm font-semibold">{t("bk.takeBackTitle", { kit: kit.courtName, code: kit.code })}</p>
          <p className="mt-0.5 text-xs text-slate-600">{t("bk.takeBackHelp", { amount: money(kit.deposit) })}</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600">{t("bk.condition")}</label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as HireCondition)}
                className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
              >
                {HIRE_CONDITIONS.map((value) => (
                  <option key={value} value={value}>
                    {conditionLabels(t)[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-full space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("bk.keptBackWhy")}</div>
              {deductions.map((d, i) => {
                const how = treatments.find((tr) => tr.reason === d.reason);
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={t("c.reason")}
                      value={d.reason}
                      onChange={(e) => setDeductions(deductions.map((x, j) => (j === i ? { ...x, reason: e.target.value as DeductionReason } : x)))}
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
                    >
                      {treatments.map((tr) => (
                        <option key={tr.reason} value={tr.reason} disabled={tr.reason !== d.reason && deductions.some((x) => x.reason === tr.reason)}>
                          {t(`srv.deduction.${tr.reason}`)}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={t("bk.amountCur")}
                      type="number"
                      step={0.01}
                      min={0}
                      max={kit.deposit}
                      value={d.amount}
                      onChange={(e) => setDeductions(deductions.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                      className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
                    />
                    {how && (
                      <span className="text-xs text-slate-500">
                        {t("bk.taxBasis", {
                          tax: how.taxed ? t("bk.taxed") : t("bk.noTax"),
                          basis:
                            how.basis === "reviewed"
                              ? t("bk.basis.reviewed")
                              : how.basis === "provisional"
                                ? t("bk.basis.provisional")
                                : t("bk.basis.venue"),
                        })}
                      </span>
                    )}
                    <button onClick={() => setDeductions(deductions.filter((_, j) => j !== i))} className="text-xs text-slate-500 underline">
                      {t("c.remove")}
                    </button>
                  </div>
                );
              })}
              {deductions.length < treatments.length && (
                <button
                  onClick={() => {
                    const free = treatments.find((tr) => !deductions.some((d) => d.reason === tr.reason));
                    if (free) setDeductions([...deductions, { reason: free.reason, amount: "" }]);
                  }}
                  className="text-xs font-semibold text-teal-700 underline"
                >
                  {deductions.length === 0 ? t("bk.keepSomeBack") : t("bk.anotherReason")}
                </button>
              )}
              {withheld > 0 && (
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  {t("bk.keptHandedBack", { kept: money(withheld), back: money(Math.max(kit.deposit - withheld, 0)) })}
                  <select
                    value={heldVia}
                    onChange={(e) => setHeldVia(e.target.value as typeof heldVia)}
                    className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
                  >
                    <option value="cash">{t("c.via.cash")}</option>
                    <option value="qr">QR</option>
                    <option value="transfer">{t("bk.heldVia.transfer")}</option>
                    <option value="card">{t("bk.heldVia.card")}</option>
                  </select>
                </div>
              )}
            </div>
            <div className="min-w-[16rem] flex-1">
              <label className="block text-xs font-medium text-slate-600">
                {condition === "ok" && withheld === 0 ? t("bk.whatHappenedOptional") : t("bk.whatHappened")}
              </label>
              <input
                value={note}
                maxLength={MAX_HIRE_NOTE}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("bk.whatHappenedPlaceholder")}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
              />
            </div>
            <button
              onClick={submitKit}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
            >
              {t("bk.takeBack")}
            </button>
            <button
              onClick={() => setKit(null)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              {t("c.cancel")}
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
          {t("c.loading")}
        </div>
      ) : bookings && bookings.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          {t("bk.noBookings", { date })}
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
                      <span className="text-xs font-semibold text-slate-400">{b.releasedUnpaid ? t("bk.releasedUnpaid") : statusLabels(t)[b.status]}</span>
                    )}
                  </div>
                </div>

                <div className="mt-2 text-sm">
                  {b.participantName ? t("apr.child.bookedFor", { name: b.participantName, adult: b.name }) : b.name}
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
                <PeopleChips b={b} act={act} />
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
                  {columns(t).map((label, i) => (
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
                      {b.participantName ? t("apr.child.bookedFor", { name: b.participantName, adult: b.name }) : b.name}
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
                        {b.releasedUnpaid ? t("bk.releasedUnpaid") : statusLabels(t)[b.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <PaymentChip b={b} act={act} />
                      <AccountChip b={b} act={act} />
                    </td>
                    <td className="px-3 py-2">
                      <AttendanceChip b={b} act={act} />
                      <PeopleChips b={b} act={act} />
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
  markPerson: (code: string, placeId: number, mark: "arrived" | "no_show" | "clear") => void;
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
  withdrawPerson: (b: AdminBookingRow, placeId: number | null, name: string | null) => void;
  checkPlaceConcession: (b: AdminBookingRow, placeBenefitId: number, outcome: "seen" | "refused") => void;
}

const CHIP = "inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-semibold transition";

function SeriesChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (!b.seriesCode) return null;
  return (
    <button
      onClick={() => act.paySeries(b.seriesCode!)}
      title={t("bk.seriesPayAll", { series: b.seriesCode })}
      className="ml-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded-full bg-violet-50 text-[10px] font-semibold text-violet-700 hover:bg-violet-100"
    >
      🔁
    </button>
  );
}

/** Booked from an account that proved, with a code sent to it, that this number is theirs. */
function CheckedPhone({ b }: { b: AdminBookingRow }) {
  const t = useStaffT();
  if (!b.phoneChecked) return null;
  return (
    <span title={t("bk.phoneChecked")} className="ml-1 text-xs font-semibold text-emerald-700">
      ✓
    </span>
  );
}

/** The venue's note on this customer, or a way to write one. */
function StaffNote({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (!b.staffNote)
    return (
      <button type="button" onClick={() => act.writeNote(b)} className="ml-1 text-xs text-slate-400 hover:text-teal-700" title={t("bk.writeNote")}>
        📝
      </button>
    );
  return (
    <button
      type="button"
      onClick={() => act.writeNote(b)}
      title={t("bk.changeNote")}
      className="mt-1 block max-w-xs rounded bg-amber-50 px-2 py-0.5 text-left text-xs text-amber-900 ring-1 ring-amber-200"
    >
      📝 {b.staffNote}
    </button>
  );
}

/** Not yet agreed to the venue's waiver: to sign at the desk. Nothing where it is signed, or asked for none. */
function WaiverChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (b.waiverSigned || b.status !== "confirmed") return null;
  return (
    <button
      type="button"
      onClick={() => act.paperWaiver(b)}
      title={t("bk.waiverTitle")}
      className="mt-1 block rounded bg-rose-50 px-2 py-0.5 text-left text-xs font-medium text-rose-800 ring-1 ring-rose-200"
    >
      ✍ {t("bk.noWaiver")}
    </button>
  );
}

/** Rackets, shuttles or drinks to hand over with the booking. */
function Extras({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (!b.addons?.length)
    return (
      <>
        {(b.players ?? 1) > 1 && <div className="mt-1 text-xs text-slate-600">👥 {t.plural("bk.players", b.players ?? 1)}</div>}
        {b.coachName && <Coach b={b} />}
        <ConcessionCheck b={b} act={act} />
      </>
    );
  return (
    <div className="mt-1 text-xs text-slate-600">
      {b.coachName && <Coach b={b} />}
      {(b.players ?? 1) > 1 && <div>👥 {t.plural("bk.players", b.players ?? 1)}</div>}
      🎒 {b.addons.map((a) => (a.kind === "rental" ? t("bk.addonHire", { qty: a.quantity, name: a.name }) : `${a.quantity} × ${a.name}`)).join(", ")}
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
  const t = useStaffT();
  const [step, setStep] = useState<"seen" | "refused" | null>(null);
  if (!b.concessionName || !b.concessionCheck) return null;
  const off = money(b.concessionOff ?? 0);
  // A built-in one used unchanged reads in the staff's language.
  const name = isConcessionPreset(b.concessionPreset) ? t(`con.preset.${b.concessionPreset}`) : b.concessionName;
  if (b.concessionCheck === "seen") return <div className="mt-1 text-xs text-emerald-700">🎫 {t("bk.concSeen", { name })}</div>;
  if (b.concessionCheck === "refused") return <div className="mt-1 text-xs text-slate-500">🎫 {t("bk.concRefused", { name })}</div>;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-amber-800">
      <span title={t("bk.concLookTitle")}>
        🎫 {t("bk.concCheck", { name, off })}
      </span>
      {b.status === "confirmed" && step === null && (
        <>
          <button onClick={() => setStep("seen")} className={`${CHIP} bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200`}>
            {t("bk.proofSeen")}
          </button>
          <button onClick={() => setStep("refused")} className={`${CHIP} bg-amber-50 text-amber-800 ring-1 ring-amber-200`}>
            {t("bk.noProof")}
          </button>
        </>
      )}
      {step === "seen" && (
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="text-slate-500">{t("bk.dontAskUntil")}</span>
          {(
            [
              ["visit", t("bk.until.visit")],
              ["month", t("bk.until.month")],
              ["year", t("bk.until.year")],
              ["twelve", t("bk.until.twelve")],
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
          <button onClick={() => setStep(null)} aria-label={t("c.cancel")} className="px-1 text-slate-400">
            ✕
          </button>
        </span>
      )}
      {step === "refused" &&
        (b.paymentStatus === "paid" ? (
          <MethodPicker label={t("bk.takeMoreBy", { off })} onPick={(via) => act.checkConcession(b, "refused", undefined, via)} onCancel={() => setStep(null)} />
        ) : (
          <span className="inline-flex items-center gap-1">
            <button onClick={() => act.checkConcession(b, "refused")} className={`${CHIP} bg-amber-600 text-white`}>
              {t("bk.chargeFull", { off })}
            </button>
            <button onClick={() => setStep(null)} aria-label={t("c.cancel")} className="px-1 text-slate-400">
              ✕
            </button>
          </span>
        ))}
    </div>
  );
}

/** A lesson: the coach, and their fee inside the price. */
function Coach({ b }: { b: AdminBookingRow }) {
  const t = useStaffT();
  return (
    <div className="mt-1 text-xs text-indigo-700">
      🎓 {t("bk.lesson", { coach: b.coachName ?? "", fee: money(b.coachFee ?? 0) })}
    </div>
  );
}

/** Strikes against this number here, where the venue counts them, with a way to let them off. */
function StrikesBadge({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (!b.strikes || b.strikes.count === 0) return null;
  const out = b.strikes.count >= b.strikes.limit;
  const counts = { count: b.strikes.count, limit: b.strikes.limit };
  return (
    <button
      onClick={() => act.forgiveStrikes(b)}
      title={out ? t("bk.strikesTitleOut", counts) : t("bk.strikesTitle", counts)}
      className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${out ? "bg-red-600 text-white" : "bg-amber-100 text-amber-800"}`}
    >
      {t("bk.strikes", counts)}
    </button>
  );
}

function NoShowBadge({ b }: { b: AdminBookingRow }) {
  const t = useStaffT();
  if (b.priorNoShows === 0) return null;
  return (
    <span
      title={t.plural("bk.priorNoShows", b.priorNoShows)}
      className="ml-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600"
    >
      ⚠ {b.priorNoShows}
    </span>
  );
}

function PaymentChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (b.status !== "confirmed") return <span className="text-xs text-slate-400">—</span>;
  // Held for payment online: it goes by itself if not paid in time.
  if (b.paymentStatus === "unpaid" && b.holdUntil)
    return (
      <span
        title={t("bk.heldTitle")}
        className={`${CHIP} bg-amber-50 text-amber-700 ring-1 ring-amber-200`}
      >
        {t("bk.heldTill", { time: localTime(b.holdUntil) })}
      </span>
    );
  // Nothing to take: a free court (a condominium's, say) owes nothing.
  if (b.totalPrice === 0 && b.paymentStatus !== "paid")
    return <span className={`${CHIP} bg-slate-100 text-slate-500`}>{t("bk.free")}</span>;
  const paid = b.paymentStatus === "paid";
  // The money is in the venue's gateway account, not the till: undoing it is
  // a refund there, not a click here.
  if (paid && b.paidOnline)
    return (
      <span
        title={t("bk.paidOnlineTitle")}
        className={`${CHIP} bg-emerald-100 text-emerald-700`}
      >
        {`✓ ${t("bk.via.online")}`}
      </span>
    );
  const asking = act.paying === b.code || (b.seriesCode !== null && act.paying === `series:${b.seriesCode}`);
  if (!paid && asking) {
    const series = act.paying !== b.code;
    return <MethodPicker
      label={series ? t("bk.seriesPaidBy", { series: b.seriesCode ?? "" }) : t("bk.paidBy")}
      onPick={(via) => (series ? act.paySeries(b.seriesCode!, via) : act.togglePaid(b.code, true, via))}
      onCancel={() => act.setPaying(null)}
    />;
  }
  return (
    <button
      onClick={() => (paid ? act.togglePaid(b.code, false) : act.setPaying(b.code))}
      title={[
        ...((b.depositPaid ?? 0) > 0 ? [t("bk.depositPaidOnline", { amount: money(b.depositPaid ?? 0) })] : []),
        ...(b.sharesPaid - (b.depositPaid ?? 0) > 0
          ? [t("bk.sharesPaidOnline", { amount: money(b.sharesPaid - (b.depositPaid ?? 0)) })]
          : []),
        ...(paid
          ? [...(b.paidVia ? [t("bk.viaSentence", { via: t(`c.via.${b.paidVia}`) })] : []), t("bk.clickUnpaid")]
          : [t("bk.clickPaid")]),
      ].join(" ")}
      className={`${CHIP} ${
        paid
          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          : "bg-amber-100 text-amber-700 hover:bg-amber-200"
      }`}
    >
      {paid
        ? `✓ ${b.paidVia ? shortVia(t)[b.paidVia] : t("bk.paidShort")}`
        : b.sharesPaid > 0
          ? t("bk.due", { amount: money(b.totalPrice - b.sharesPaid) })
          : t("bk.unpaidShort")}
    </button>
  );
}

/**
 * Charged to a company or school account: which, and whether it is on an
 * invoice yet. An unpaid booking can be put on one here, or taken off until invoiced.
 */
function AccountChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  const [choices, setChoices] = useState<{ id: number; name: string }[] | null>(null);
  if (b.status !== "confirmed") return null;
  if (b.accountName)
    return (
      <span className={`${CHIP} mt-1 gap-1 bg-sky-50 text-sky-800 ring-1 ring-sky-200`} title={t("bk.accountTitle")}>
        🏢 {b.accountName}
        {b.invoiced ? ` · ${t("bk.invoiced")}` : ""}
        {!b.invoiced && b.paymentStatus === "unpaid" && (
          <button type="button" aria-label={t("bk.takeOffAccount")} onClick={() => act.charge(b, null)} className="text-sky-500 hover:text-red-600">
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
        {t("bk.onAccount")}
      </button>
    );
  if (choices.length === 0) return <span className="mt-1 block text-xs text-slate-400">{t("bk.noAccounts")}</span>;
  return (
    <select
      aria-label={t("bk.chargeToAccount")}
      defaultValue=""
      onChange={(e) => e.target.value && act.charge(b, Number(e.target.value))}
      className="mt-1 block rounded-md border border-slate-300 px-1 py-0.5 text-xs"
    >
      <option value="">{t("bk.chargeTo")}</option>
      {choices.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

/** How it was paid, in a word, for a chip. */
function shortVia(t: StaffT): Record<PaidVia, string> {
  return {
    cash: t("bk.via.cash"),
    qr: t("bk.via.qr"),
    transfer: t("bk.via.transfer"),
    card: t("bk.via.card"),
    online: t("bk.via.online"),
    pass: t("bk.via.pass"),
    credit: t("bk.via.credit"),
  };
}

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
  const t = useStaffT();
  const short = shortVia(t);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-xs text-slate-500">{label}</span>
      {COUNTER_METHODS.map((m) => (
        <button
          key={m}
          onClick={() => onPick(m)}
          title={t(`c.via.${m}`)}
          className={`${CHIP} bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100`}
        >
          {short[m]}
        </button>
      ))}
      <button onClick={onCancel} aria-label={t("c.cancel")} className="px-1 text-xs text-slate-400 hover:text-slate-600">
        ✕
      </button>
    </span>
  );
}

function AttendanceChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (b.status !== "confirmed") return <span className="text-xs text-slate-400">—</span>;
  if (b.checkedInAt)
    return (
      <button
        onClick={() => act.toggleCheckIn(b.code, !b.checkedOutAt)}
        title={
          b.checkedOutAt
            ? t("bk.leftAt", { time: localTime(b.checkedOutAt) })
            : t("bk.arrived", { time: localTime(b.checkedInAt) })
        }
        className={`${CHIP} ${
          b.checkedOutAt
            ? "bg-slate-100 text-slate-500"
            : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
        }`}
      >
        {b.checkedOutAt ? t("bk.left", { time: localTime(b.checkedOutAt) }) : t("bk.in", { time: localTime(b.checkedInAt) })}
      </button>
    );
  return (
    <span className="inline-flex gap-1">
      <button
        onClick={() => act.toggleCheckIn(b.code, false)}
        title={t("bk.checkInTitle")}
        className={`${CHIP} bg-teal-50 text-teal-700 hover:bg-teal-100`}
      >
        {t("bk.checkIn")}
      </button>
      <button
        onClick={() => act.toggleNoShow(b.code, !b.noShow)}
        title={b.noShow ? t("bk.clearNoShow") : t("bk.markNoShow")}
        className={`${CHIP} ${
          b.noShow
            ? "bg-red-100 text-red-700 hover:bg-red-200"
            : "bg-slate-100 text-slate-500 hover:bg-slate-200"
        }`}
      >
        {b.noShow ? t("bk.noShow") : t("bk.noShowQ")}
      </button>
    </span>
  );
}

/**
 * Each person a booking names (lib/participant-bookings.ts), and whether they
 * came: arrived, a no-show, or not yet said. Pressing moves one person on;
 * the booking counts as a no-show only when nobody it names came.
 */
function PeopleChips({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (b.status !== "confirmed") return null;
  // Places nobody is named on, one of which a group can give up (lib/place-withdrawals.ts); a court hired whole has none.
  const unnamed = b.classId === null ? Math.max(0, (b.players ?? 1) - Math.max(1, b.people.length)) : 0;
  const concessions = b.placeConcessions ?? [];
  if (b.people.length === 0 && unnamed === 0 && concessions.length === 0) return null;
  return (
    <>
      {(b.people.length > 0 || unnamed > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-1" aria-label={t("pbk.att.title")}>
          {b.people.length > 0 && <span className="text-xs text-slate-500">{t("pbk.att.title")}</span>}
          {b.people.map((p) => {
            const name = p.name ?? t("pbk.att.someone");
            const next = p.arrivedAt ? "no_show" : p.noShow ? "clear" : "arrived";
            return (
              <span key={p.placeId} className="inline-flex items-center">
                <button
                  type="button"
                  onClick={() => act.markPerson(b.code, p.placeId, next)}
                  title={t(next === "arrived" ? "pbk.att.markArrived" : next === "no_show" ? "pbk.att.markNoShow" : "pbk.att.clear", { name })}
                  className={`${CHIP} ${
                    p.arrivedAt ? "bg-emerald-100 text-emerald-700" : p.noShow ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {t(p.arrivedAt ? "pbk.att.in" : p.noShow ? "pbk.att.noShow" : "pbk.att.unknown", { name })}
                </button>
                {!p.arrivedAt && !p.noShow && b.people.length > 1 && (
                  <button
                    type="button"
                    onClick={() => act.withdrawPerson(b, p.placeId, name)}
                    title={t("ent.bk.takeOffTitle", { name })}
                    aria-label={t("ent.bk.takeOffTitle", { name })}
                    className="ml-0.5 inline-flex min-h-6 min-w-6 items-center justify-center rounded-full text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
                  >
                    ✕
                  </button>
                )}
              </span>
            );
          })}
          {unnamed > 0 && (
            <button
              type="button"
              onClick={() => act.withdrawPerson(b, null, null)}
              title={t("ent.bk.giveUpTitle", { n: unnamed })}
              className={`${CHIP} bg-slate-50 text-slate-500 hover:bg-red-50 hover:text-red-600`}
            >
              {t("ent.bk.giveUp")}
            </button>
          )}
        </div>
      )}
      {concessions.map((c) => {
        const name = c.name ?? t("pbk.att.someone");
        if (c.check === "seen") return <div key={c.id} className="mt-1 text-xs text-emerald-700">🎫 {t("ent.bk.concSeen", { concession: c.concessionName, name })}</div>;
        if (c.check === "refused") return <div key={c.id} className="mt-1 text-xs text-slate-500">🎫 {t("ent.bk.concRefused", { concession: c.concessionName, name })}</div>;
        return (
          <div key={c.id} className="mt-1 flex flex-wrap items-center gap-1 text-xs text-amber-800">
            🎫 {t("ent.bk.concDue", { concession: c.concessionName, name, amount: money(c.amount) })}
            <button type="button" onClick={() => act.checkPlaceConcession(b, c.id, "seen")} className={`${CHIP} bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}>
              {t("ent.bk.proofSeen")}
            </button>
            <button type="button" onClick={() => act.checkPlaceConcession(b, c.id, "refused")} className={`${CHIP} bg-red-50 text-red-700 hover:bg-red-100`}>
              {t("ent.bk.noProof")}
            </button>
          </div>
        );
      })}
    </>
  );
}

function KitChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (b.hire === null && (b.courtDeposit === 0 || b.status !== "confirmed")) return null;
  if (b.hire === null)
    return (
      <button
        onClick={() => act.openKit(b, "take")}
        title={t("bk.handOutTitle", { kit: b.courtName, amount: money(b.courtDeposit) })}
        className={`${CHIP} bg-amber-50 text-amber-700 hover:bg-amber-100`}
      >
        {t("bk.handOut")}
      </button>
    );
  if (b.hire.returnedAt === null)
    return (
      <button
        onClick={() => act.openKit(b, "return")}
        title={t("bk.outTitle", { time: localTime(b.hire.takenAt), amount: money(b.hire.deposit) })}
        className={`${CHIP} bg-amber-100 text-amber-800 hover:bg-amber-200`}
      >
        {t("bk.out", { amount: money(b.hire.deposit) })}
      </button>
    );
  return (
    <span
      title={
        (b.hire.note ?? t("bk.noNote")) + (b.hire.withheld ? ` ${t("bk.keptBackNote", { amount: money(b.hire.withheld) })}` : "")
      }
      className={`${CHIP} ${
        b.hire.condition === "ok" ? "bg-slate-100 text-slate-500" : "bg-red-100 text-red-700"
      }`}
    >
      {b.hire.condition === "ok"
        ? t("bk.back")
        : `${conditionLabels(t)[b.hire.condition!].toLowerCase()}${
            b.hire.withheld ? ` · ${money(b.hire.withheld)}` : ""
          }`}
    </span>
  );
}

function RowActions({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (b.status !== "confirmed") return null;
  return (
    <>
      <button
        onClick={() => act.openMove(b.code)}
        title={t("bk.moveTitle")}
        className="inline-flex min-h-7 items-center rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
      >
        {t("bk.move")}
      </button>
      {b.classId === null && !b.checkedInAt && (
        <button
          onClick={() => act.openChange(b)}
          title={t("bk.changeTimeTitle")}
          className="inline-flex min-h-7 items-center rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
        >
          {t("bk.changeTime")}
        </button>
      )}
      <button
        onClick={() => act.cancelBooking(b.code)}
        className="inline-flex min-h-7 items-center rounded-md border border-red-300 px-2.5 text-xs font-medium text-red-600 hover:bg-red-50"
      >
        {t("c.cancel")}
      </button>
      <button
        onClick={() => act.blockNumber(b)}
        title={t("bk.blockTitle")}
        className="inline-flex min-h-7 items-center rounded-md px-2 text-xs text-slate-400 hover:text-red-600"
      >
        {t("bk.blockNumber")}
      </button>
    </>
  );
}
