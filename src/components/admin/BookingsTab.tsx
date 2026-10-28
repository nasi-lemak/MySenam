"use client";

import { readJson } from "@/lib/read-response";
import { useStaffMay } from "./StaffMay";
import { activityIcon } from "@/lib/activity-registry";
import { AttentionPanel } from "./AttentionPanel";
import { EnquiriesPanel } from "./EnquiriesPanel";
import { ChangeTime } from "@/components/ChangeTime";
import { LessonCoach } from "./LessonCoach";
import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, formatHour, todayISO } from "@/lib/time";
import { COUNTER_METHODS, HIRE_CONDITIONS, MAX_DEPOSIT, MAX_HIRE_NOTE, MAX_VENUE_AHEAD_DAYS, PAID_VIA_LABELS } from "@/lib/types";
import type { BookingStatus, CounterMethod, PaidVia } from "@/lib/types";
import type { Court, HireCondition } from "@/lib/types";
import type { AdminBookingRow, BookingHit } from "@/lib/store";
import type { DeductionReason, DeductionTreatment } from "@/lib/deposit-deductions";
import type { StaffPhrase, StaffT } from "@/lib/staff-i18n";
import { todayLocal } from "./shared";
import { isDay, UpdatedNote, useAddressed, useAutoRefresh } from "./place";
import { clockTime, money, region } from "@/lib/region";
import { isConcessionPreset } from "@/lib/concessions-shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import PassAllocation, { passCodesOf, type AllocPass } from "@/components/PassAllocation";
import type { PlanPlace } from "@/lib/pass-rules";
import { errorText } from "@/lib/i18n";
import { lengthLabel } from "@/lib/length-label";
import type { CancelOutcome, CounterPayout, StaffCancelOption, StaffCancelPreview, StaffSeriesWeek } from "@/lib/counter-refunds";
import type { CorrectionScope } from "@/lib/booking-corrections";
import { AdjustPrice } from "./AdjustPrice";

/* ---------------- Bookings tab ---------------- */

function columns(t: StaffT, showVenue: boolean): string[] {
  return [
    t("bk.col.code"),
    ...(showVenue ? [t("c.venue")] : []),
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

/**
 * The day sheet printed (X1-18): only the list of the day, as a table, without
 * the dashboard around it or the actions in it.
 */
const PRINT_CSS = `@media print {
  body * { visibility: hidden; }
  #day-sheet, #day-sheet * { visibility: visible; }
  #day-sheet { position: absolute; left: 0; top: 0; width: 100%; }
}`;

/** A venue the staff member works at, for the *New booking* link and the filters. */
export interface DayVenue {
  id: number;
  name: string;
}

export function BookingsTab({ venues = [] }: { venues?: DayVenue[] } = {}) {
  const t = useStaffT();
  const clock = useStaffClock();
  // The day is in the address, as the tab is (components/admin/place.tsx).
  const [date, setDate] = useAddressed("date", todayLocal, isDay);
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
  // A lesson being changed: the coach it goes with (its own unless staff choose another).
  const [changeCoach, setChangeCoach] = useState<number | null>(null);
  const otherCoach = changing?.coachId && changeCoach !== null && changeCoach !== changing.coachId ? changeCoach : null;
  // A paid lesson to another coach: the manager's word on the money (lib/lesson-coaches.ts), asked before any time is offered.
  const [coachMoney, setCoachMoney] = useState<"keep" | "adjust" | null>(null);
  const coachBody = otherCoach !== null ? { coachId: otherCoach, ...(coachMoney ? { coachMoney } : {}) } : {};
  const moneyAsked = otherCoach !== null && changing?.paymentStatus === "paid" && coachMoney === null;
  const changeOptionsUrl = useCallback(
    (day: string) =>
      `/api/admin/bookings/reschedule?code=${encodeURIComponent(changing?.code ?? "")}&date=${day}${otherCoach !== null ? `&coachId=${otherCoach}` : ""}`,
    [changing?.code, otherCoach]
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
  // Money handed back at the counter that day (lib/counter-refunds.ts), for the till.
  const [payouts, setPayouts] = useState<CounterPayout[]>([]);
  // A booking being cancelled: what was paid and how, the venue's terms, and the ways to settle it.
  const [cancelling, setCancelling] = useState<{ preview: StaffCancelPreview; venueId: number | null } | null>(null);
  // Weeks of a series being cancelled, with how what was paid is settled.
  const [seriesCx, setSeriesCx] = useState<{ seriesCode: string; weeks: StaffSeriesWeek[]; chosen: string[]; outcome: CancelOutcome } | null>(null);
  // A booking's name, number or email being corrected.
  const [correcting, setCorrecting] = useState<{ b: AdminBookingRow; name: string; phone: string; email: string; scope: CorrectionScope } | null>(null);
  // The day list's filters: unpaid, not checked in, one court, one venue.
  const [onlyUnpaid, setOnlyUnpaid] = useState(false);
  const [onlyNotIn, setOnlyNotIn] = useState(false);
  const [courtFilter, setCourtFilter] = useState("");
  const [venueFilter, setVenueFilter] = useState("");

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
      const data = await readJson(res);
      if (mine !== asked.current) return;
      if (!res.ok) throw new Error(t.err(data, t("bk.loadFailed")));
      setBookings(data.bookings);
      setPayouts(Array.isArray(data.payouts) ? data.payouts : []);
      setRevenue(data.revenue);
      setCollected(data.collected);
      setOutstanding(data.outstanding);
      loaded();
    } catch (err) {
      if (mine !== asked.current) return;
      setError(err instanceof Error ? err.message : t("bk.loadFailed"));
      setBookings(null);
    } finally {
      if (mine === asked.current) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loaded` is stable
  }, [date, t]);
  // Read again every minute while it is on screen: online bookings, cancellations, check-ins and payments show (audit R8 X2-14).
  const { updatedAt, loaded } = useAutoRefresh(load);

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
      const data = await readJson(res);
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
      const data = await readJson(res);
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
    setChangeCoach(b.coachId ?? null);
    setCoachMoney(null);
  }

  /** The difference owed for a dearer coach, taken at the counter (lib/lesson-coaches.ts): its own receipt. */
  async function collectCoachDifference(b: AdminBookingRow, changeId: number, via: CounterMethod, closePage = false) {
    setError(null);
    setPaying(null);
    try {
      const res = await fetch("/api/admin/bookings/lesson-coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId: b.venueId, changeId, method: via, ...(closePage ? { closePage: true } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("bk.paymentFailed")));
      setNotice(t("co6.bk.owedTaken", { amount: money(data.amount), code: b.code }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.paymentFailed"));
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
    setDeductions([]);
    setNote("");
    if (mode === "return")
      fetch(`/api/admin/hire?venueId=${b.venueId}`, { cache: "no-store" })
        .then((r) => readJson(r))
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
      const data = await readJson(res);
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

  /** Cancelling: first what was paid and how, and the venue's terms (lib/counter-refunds.ts), then a choice. */
  async function cancelBooking(code: string) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, preview: true }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("bk.cancelFailed")));
      setCancelling({ preview: data.preview, venueId: bookings?.find((b) => b.code === code)?.venueId ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.cancelFailed"));
    }
  }

  /** Cancel it, settled as chosen, on the amount staff were shown. */
  async function confirmCancel(option: StaffCancelOption) {
    if (!cancelling) return;
    const code = cancelling.preview.code;
    setError(null);
    try {
      const res = await fetch("/api/admin/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, outcome: option.outcome, expectRefund: option.refund }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("bk.cancelFailed")));
      const settled = data.settled as { outcome: CancelOutcome; kept: number; paidOut?: { amount: number }; credited?: number } | null;
      setNotice(
        settled?.paidOut
          ? t("p8a.cx.donePaidOut", { code, amount: money(settled.paidOut.amount) })
          : settled?.credited
            ? t("p8a.cx.doneCredit", { code, amount: money(settled.credited) })
            : settled?.outcome === "keep"
              ? t("p8a.cx.doneKept", { code, kept: money(settled.kept) })
              : t("p8a.cx.done", { code })
      );
      setCancelling(null);
      load();
      window.dispatchEvent(new Event("attention:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.cancelFailed"));
    }
  }

  /** The weeks of a series still to come, each with its own terms. */
  async function openSeriesCancel(seriesCode: string) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/bookings/cancel-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesCode, preview: true }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("p8a.sx.failed")));
      const weeks = data.weeks as StaffSeriesWeek[];
      setSeriesCx({ seriesCode, weeks, chosen: weeks.filter((w) => w.open).map((w) => w.code), outcome: "back" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p8a.sx.failed"));
    }
  }

  async function confirmSeriesCancel() {
    if (!seriesCx) return;
    setError(null);
    const expect = Object.fromEntries(
      seriesCx.weeks.filter((w) => seriesCx.chosen.includes(w.code)).map((w) => [w.code, weekOption(w, seriesCx.outcome).refund])
    );
    try {
      const res = await fetch("/api/admin/bookings/cancel-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesCode: seriesCx.seriesCode, codes: seriesCx.chosen, outcome: seriesCx.outcome, expect }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("p8a.sx.failed")));
      const left = data.left as { code: string; error: string }[];
      setNotice(
        [t("p8a.sx.done", { n: data.cancelled.length }), left.length > 0 ? t("p8a.sx.left", { list: left.map((l) => `${l.code} (${t.err(l.error)})`).join(", ") }) : ""]
          .filter(Boolean)
          .join(" ")
      );
      setSeriesCx(null);
      load();
      window.dispatchEvent(new Event("attention:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p8a.sx.failed"));
    }
  }

  function openCorrect(b: AdminBookingRow) {
    setError(null);
    setNotice(null);
    setCorrecting({ b, name: b.name, phone: b.phone, email: b.email ?? "", scope: "booking" });
  }

  /**
   * A booking's name, number or email put right (lib/booking-corrections.ts).
   * A new number refused by a policy this venue lets its managers override:
   * a manager is asked why, and it is sent again with the override.
   */
  async function submitCorrection(override?: { policy: string; reason: string }) {
    if (!correcting) return;
    const { b, name, phone, email, scope } = correcting;
    setError(null);
    try {
      const res = await fetch("/api/admin/bookings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: b.code,
          name,
          phone,
          email: email.trim() === "" ? null : email.trim(),
          scope,
          ...(override ? { overridePolicies: [override.policy], overrideReason: override.reason } : {}),
        }),
      });
      const data = await readJson(res);
      if (!res.ok && !override && data.overridable === true && typeof data.policy === "string") {
        const reason = window.prompt(t("p8a.fix.overridePrompt", { error: t.err(data) }));
        if (reason === null) return;
        return await submitCorrection({ policy: data.policy, reason });
      }
      if (!res.ok) throw new Error(t.err(data, t("p8a.fix.failed")));
      setNotice(t("p8a.fix.saved", { codes: (data.codes as string[]).join(", ") }));
      setCorrecting(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p8a.fix.failed"));
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
      const data = await readJson(res);
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("ent.bk.takeOffFailed")));
      const w = data.withdrawal as { name: string | null; refund: number; owedLess: number; units: number; price: number; how: string; deposit?: number };
      // On an account already invoiced, the booker's part is a credit note on the account; a deposit's part goes back as paid.
      const onAccount = w.how === "account" ? Math.round((w.refund - (w.deposit ?? 0)) * 100) / 100 : 0;
      setNotice(
        [
          w.name ? t("ent.bk.tookOff", { name: w.name }) : t("ent.bk.gaveUp"),
          w.owedLess > 0 ? t("ent.bk.owedLess", { amount: money(w.owedLess) }) : "",
          onAccount > 0 ? t("pw6.bk.toAccount", { amount: money(onAccount) }) : "",
          w.refund - onAccount > 0 ? t("ent.bk.refunded", { amount: money(w.refund - onAccount) }) : "",
          w.refund <= 0 && w.owedLess <= 0 && w.units <= 0 ? t("ent.bk.noPrice") : "",
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
  async function checkPlaceConcession(b: AdminBookingRow, placeBenefitId: number, outcome: "seen" | "refused", remember?: string) {
    setError(null);
    try {
      const res = await fetch("/api/admin/concessions/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: b.id, placeBenefitId, outcome, remember }),
      });
      const data = await readJson(res);
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
    const data = await readJson(res);
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
    if (!res.ok) setError(t.err(await readJson(res), t("bk.recordFailed")));
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
    const data = await readJson(res);
    if (!res.ok) setError(t.err(data, t("bk.accountFailed")));
    load();
  }

  /** Paid with passes, one for the booking or one person's own for each place (lib/pass-rules.ts): the refusal, or null once paid. */
  async function payWithPasses(code: string, passCodes: string[]): Promise<string | null> {
    setError(null);
    try {
      const res = await fetch("/api/admin/bookings/passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, passCodes }),
      });
      const data = await readJson(res);
      if (!res.ok) return t.err(data, t("stk.bk.failed"));
      setPaying(null);
      load();
      return null;
    } catch {
      return t("stk.bk.failed");
    }
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("bk.paymentFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.paymentFailed"));
    }
  }

  /**
   * Somebody on a members' session whose membership no longer covers it
   * (`MV6_DESK_WARNING`): staff are told who and why, and decide. Undefined:
   * not that warning; null: staff did not admit them; else the note to send
   * with `admit`, recorded with the check-in.
   */
  function decideAdmission(data: { code?: string; warnings?: { name: string; date: string; lapse?: { kind: string; until?: string } }[] }): { note: string } | null | undefined {
    if (data.code !== "MV6_DESK_WARNING" || !Array.isArray(data.warnings)) return undefined;
    const lines = data.warnings.map((w) =>
      w.lapse?.kind === "ended"
        ? t("mv6.bk.warnEnded", { name: w.name, until: w.lapse.until ?? "", date: w.date })
        : w.lapse?.kind === "cancelled"
          ? t("mv6.bk.warnCancelled", { name: w.name })
          : w.lapse?.kind === "suspended"
            ? t("ms7.bk.warnSuspended", { name: w.name, date: w.date })
            : t("mv6.bk.warnNone", { name: w.name, date: w.date })
    );
    if (!window.confirm([t("mv6.bk.warnTitle"), ...lines, "", t("mv6.bk.admitConfirm")].join("\n"))) return null;
    const note = window.prompt(t("mv6.bk.admitNote"));
    return note === null ? null : { note };
  }

  async function toggleCheckIn(code: string, out: boolean, admit?: { note: string }) {
    setError(null);
    try {
      const res = await fetch("/api/admin/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, out, ...(admit ? { admit: true, note: admit.note } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok && !admit) {
        const decided = decideAdmission(data);
        if (decided === null) return;
        if (decided) return await toggleCheckIn(code, out, decided);
      }
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
      const data = await readJson(res);
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("bk.forgiveFailed")));
      setNotice(t("bk.forgiven", { phone: b.phone, venue: b.venueName }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bk.forgiveFailed"));
    }
  }

  /** One person a booking names arrived, did not, or clear it (lib/store.ts `markPlace`). */
  async function markPerson(code: string, placeId: number, mark: "arrived" | "no_show" | "clear", admit?: { note: string }) {
    setError(null);
    try {
      const res = await fetch("/api/admin/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, placeId, mark, ...(admit ? { admit: true, note: admit.note } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok && !admit) {
        const decided = decideAdmission(data);
        if (decided === null) return;
        if (decided) return await markPerson(code, placeId, mark, decided);
      }
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
      const data = await readJson(res);
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
      const data = await readJson(res);
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
    openSeriesCancel,
    openCorrect,
    paySeries,
    blockNumber,
    forgiveStrikes,
    checkConcession,
    charge,
    writeNote,
    paperWaiver,
    withdrawPerson,
    checkPlaceConcession,
    payWithPasses,
    collectCoachDifference,
  };

  // Through the filters; the venue column only where more than one venue is shown.
  const shown = (bookings ?? []).filter(
    (b) =>
      (!onlyUnpaid || (b.status === "confirmed" && b.paymentStatus !== "paid" && b.totalPrice > 0)) &&
      (!onlyNotIn || (b.status === "confirmed" && !b.checkedInAt)) &&
      (courtFilter === "" || String(b.courtId) === courtFilter) &&
      (venueFilter === "" || String(b.venueId) === venueFilter)
  );
  const dayVenues = [...new Map((bookings ?? []).map((b) => [b.venueId, b.venueName])).entries()];
  const showVenue = new Set(shown.map((b) => b.venueId)).size > 1;
  const dayCourts = [...new Map((bookings ?? []).filter((b) => venueFilter === "" || String(b.venueId) === venueFilter).map((b) => [b.courtId, showVenue ? `${b.courtName} · ${b.venueName}` : b.courtName])).entries()];
  const filtered = onlyUnpaid || onlyNotIn || courtFilter !== "" || venueFilter !== "";

  return (
    <div className="space-y-4">
      <style>{PRINT_CSS}</style>
      <AttentionPanel />
      <EnquiriesPanel />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (query.trim().length < 3) return setHits(null);
          const res = await fetch(`/api/admin/bookings?q=${encodeURIComponent(query.trim())}`, { cache: "no-store" });
          setHits(res.ok ? ((await readJson(res)).hits as BookingHit[]) : []);
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
                      {h.date} {formatHour(h.startHour, t.locale)}–{formatHour(h.endHour, t.locale)}
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
        <NewBooking venues={venues} date={date} />
        <UpdatedNote at={updatedAt} />
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

      {bookings && bookings.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="day-filters">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={onlyUnpaid} onChange={(e) => setOnlyUnpaid(e.target.checked)} />
            {t("p8a.day.unpaid")}
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={onlyNotIn} onChange={(e) => setOnlyNotIn(e.target.checked)} />
            {t("p8a.day.notIn")}
          </label>
          {dayVenues.length > 1 && (
            <select
              aria-label={t("p8a.day.filterVenue")}
              value={venueFilter}
              onChange={(e) => {
                setVenueFilter(e.target.value);
                setCourtFilter("");
              }}
              className="min-h-9 rounded-md border border-slate-300 px-2 text-sm"
            >
              <option value="">{t("p8a.day.allVenues")}</option>
              {dayVenues.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {dayCourts.length > 1 && (
            <select aria-label={t("p8a.day.filterCourt")} value={courtFilter} onChange={(e) => setCourtFilter(e.target.value)} className="min-h-9 rounded-md border border-slate-300 px-2 text-sm">
              <option value="">{t("p8a.day.allCourts")}</option>
              {dayCourts.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {filtered && <span className="text-slate-500">{t("p8a.day.shown", { shown: shown.length, total: bookings.length })}</span>}
          <button type="button" onClick={() => window.print()} className="ml-auto min-h-9 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:border-teal-500">
            {t("p8a.day.print")}
          </button>
        </div>
      )}

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

      {cancelling && (
        <CancelPanel preview={cancelling.preview} venueId={cancelling.venueId} onChoose={(o) => void confirmCancel(o)} onClose={() => setCancelling(null)} />
      )}

      {seriesCx && (
        <SeriesCancelPanel
          state={seriesCx}
          onChange={setSeriesCx}
          onConfirm={() => void confirmSeriesCancel()}
          onClose={() => setSeriesCx(null)}
        />
      )}

      {correcting && (
        <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3 text-sm" data-testid="correct-details">
          <p className="font-semibold">{t("p8a.fix.title", { code: correcting.b.code })}</p>
          <p className="mt-0.5 text-xs text-slate-600">{t("p8a.fix.help")}</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            {(
              [
                ["name", t("p8a.fix.name"), "text"],
                ["phone", t("p8a.fix.phone"), "tel"],
                ["email", t("p8a.fix.email"), "email"],
              ] as const
            ).map(([key, label, type]) => (
              <label key={key} className="text-xs font-medium text-slate-600">
                {label}
                <input
                  type={type}
                  value={correcting[key]}
                  onChange={(e) => setCorrecting({ ...correcting, [key]: e.target.value })}
                  className="mt-1 block w-56 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
                />
              </label>
            ))}
          </div>
          {(correcting.b.seriesCode || correcting.b.groupCode) && (
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {(
                [
                  ["booking", t("p8a.fix.scope.booking")],
                  ...(correcting.b.seriesCode ? [["series", t("p8a.fix.scope.series")] as const] : []),
                  ...(correcting.b.groupCode ? [["group", t("p8a.fix.scope.group")] as const] : []),
                ] as const
              ).map(([scope, label]) => (
                <label key={scope} className="inline-flex items-center gap-1">
                  <input type="radio" name="correct-scope" checked={correcting.scope === scope} onChange={() => setCorrecting({ ...correcting, scope })} />
                  {label}
                </label>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void submitCorrection()} className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700">
              {t("p8a.fix.save")}
            </button>
            <button type="button" onClick={() => setCorrecting(null)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700">
              {t("c.cancel")}
            </button>
          </div>
        </div>
      )}

      {payouts.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm" data-testid="payouts">
          <p className="font-semibold text-amber-900">{t("p8a.day.payouts", { date })}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
            {payouts.map((p) => (
              <li key={p.id}>
                {t("p8a.day.payoutLine", {
                  time: clock.time(p.paidOutAt, p.venueId),
                  amount: money(p.amount),
                  via: p.via ? t(`c.via.${p.via}`) : t("p8a.day.viaUnrecorded"),
                  code: p.creditNote ? `${p.bookingCode} (${p.creditNote})` : p.bookingCode,
                  by: p.adminName,
                })}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs font-semibold text-amber-900">{t("p8a.day.payoutTotal", { amount: money(payouts.reduce((sum, p) => sum + p.amount, 0)) })}</p>
        </div>
      )}

      {changing?.coachId && (
        <LessonCoach
          venueId={changing.venueId}
          sport={changing.sport}
          coachId={changing.coachId}
          coachName={changing.coachName ?? ""}
          value={changeCoach ?? changing.coachId}
          onChange={(id) => {
            setChangeCoach(id);
            setCoachMoney(null);
          }}
          code={changing.code}
          paid={changing.paymentStatus === "paid"}
          money={coachMoney}
          onMoney={setCoachMoney}
        />
      )}
      {changing && !moneyAsked && (
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
              body: JSON.stringify({ code: changing.code, date: day, start: o.startMin, courtId: o.courtId, ...coachBody, preview: true }),
            })
          }
          submit={(o, day, reason) =>
            fetch("/api/admin/bookings/reschedule", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: changing.code, date: day, start: o.startMin, courtId: o.courtId, ...coachBody, ...(reason ? { reason } : {}) }),
            })
          }
          onDone={(booking) => {
            setChanging(null);
            const when = { code: booking.code, date: booking.date, time: `${formatHour(booking.startHour, t.locale)}–${formatHour(booking.endHour, t.locale)}` };
            setNotice(
              booking.paymentStatus === "paid"
                ? t("bk.changedPaid", when)
                : t("bk.changedToPay", { ...when, amount: money(booking.totalPrice) })
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
            <input aria-label={t("bk.depositHeld")}
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
              <select aria-label={t("bk.condition")}
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
                  <select aria-label={t("q8b.l.method")}
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
                placeholder={t("bk.whatHappenedPlaceholder")} aria-label={t("bk.whatHappenedPlaceholder")}
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
      ) : bookings && shown.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">{t("p8a.day.noneMatch")}</div>
      ) : bookings ? (
        <div id="day-sheet">
          <h2 className="mb-2 hidden text-lg font-bold print:block">{t("p8a.day.sheet", { date })}</h2>
          {/* A counter runs on a phone as often as a screen. Below `lg` the
              same bookings are a list of cards, because a twelve-column table
              on a 390px screen means scrolling sideways to find the button you
              press the most. */}
          <ul className="space-y-3 lg:hidden print:hidden">
            {shown.map((b) => (
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
                      {formatHour(b.startHour, t.locale)} – {formatHour(b.endHour, t.locale)}
                      {showVenue ? ` · ${b.venueName}` : ""}
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
                  <OverrideNote b={b} />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <PaymentChip b={b} act={act} />
                  <AccountChip b={b} act={act} />
                  <AdjustPrice b={b} onDone={() => void load()} />
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

          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm lg:block print:block print:overflow-visible print:shadow-none">
            <table className="w-full min-w-[860px] text-sm print:min-w-0">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  {columns(t, showVenue).map((label, i, all) => (
                    <th key={i} className={`px-3 py-2 font-semibold${i === all.length - 1 ? " print:hidden" : ""}`}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => (
                  <tr key={b.id} className={`border-b border-slate-100 last:border-0 ${b.code === found ? "bg-teal-50" : ""}`}>
                    <td className="px-3 py-2 font-mono font-medium text-teal-700">
                      {b.code}
                      <SeriesChip b={b} act={act} />
                    </td>
                    {showVenue && <td className="px-3 py-2">{b.venueName}</td>}
                    <td className="px-3 py-2">
                      {activityIcon(b.sport)} {b.courtName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatHour(b.startHour, t.locale)} – {formatHour(b.endHour, t.locale)}
                    </td>
                    <td className="px-3 py-2">
                      {b.participantName ? t("apr.child.bookedFor", { name: b.participantName, adult: b.name }) : b.name}
                      <NoShowBadge b={b} />
                  <StrikesBadge b={b} act={act} />
                      <Extras b={b} act={act} />
                      <StaffNote b={b} act={act} />
                      <WaiverChip b={b} act={act} />
                      <OverrideNote b={b} />
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
                      <AdjustPrice b={b} onDone={() => void load()} />
                    </td>
                    <td className="px-3 py-2">
                      <AttendanceChip b={b} act={act} />
                      <PeopleChips b={b} act={act} />
                    </td>
                    <td className="px-3 py-2">
                      <KitChip b={b} act={act} />
                    </td>
                    <td className="px-3 py-2 text-right print:hidden">
                      <RowMenu b={b} act={act} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
  openSeriesCancel: (seriesCode: string) => void;
  openCorrect: (b: AdminBookingRow) => void;
  paySeries: (seriesCode: string, via?: CounterMethod) => void;
  blockNumber: (b: AdminBookingRow) => void;
  forgiveStrikes: (b: AdminBookingRow) => void;
  checkConcession: (b: AdminBookingRow, outcome: "seen" | "refused", remember?: string, via?: CounterMethod) => void;
  charge: (b: AdminBookingRow, accountId: number | null) => void;
  writeNote: (b: AdminBookingRow) => void;
  paperWaiver: (b: AdminBookingRow) => void;
  withdrawPerson: (b: AdminBookingRow, placeId: number | null, name: string | null) => void;
  checkPlaceConcession: (b: AdminBookingRow, placeBenefitId: number, outcome: "seen" | "refused", remember?: string) => void;
  payWithPasses: (code: string, passCodes: string[]) => Promise<string | null>;
  collectCoachDifference: (b: AdminBookingRow, changeId: number, via: CounterMethod, closePage?: boolean) => void;
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

/** A manager's override of the venue's policies that let this booking through: which, by whom, and why (lib/policy-overrides.ts). */
function OverrideNote({ b }: { b: AdminBookingRow }) {
  const t = useStaffT();
  if (!b.policyOverrides?.length) return null;
  const byWhom = [...new Set(b.policyOverrides.map((o) => o.adminName))];
  return (
    <div className="mt-1 text-xs text-amber-800">
      {byWhom.map((by) => {
        const theirs = b.policyOverrides!.filter((o) => o.adminName === by);
        return (
          <div key={by}>
            {t("r9.row.overridden", {
              by,
              what: theirs.map((o) => t((o.policy === "guest_allowance" ? "gc8.policy.guest_allowance" : `r9.policy.${o.policy}`) as StaffPhrase)).join(", "),
              reason: theirs[0].reason,
            })}
          </div>
        );
      })}
    </div>
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
        {b.coachName && <Coach b={b} act={act} />}
        <ConcessionCheck b={b} act={act} />
      </>
    );
  return (
    <div className="mt-1 text-xs text-slate-600">
      {b.coachName && <Coach b={b} act={act} />}
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

/**
 * A lesson: the coach, and their fee inside the price; and a dearer coach's difference: still owed (to take here),
 * being paid online (a page open: taking it here closes that page), or paid, and how.
 */
function Coach({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  return (
    <div className="mt-1 text-xs text-indigo-700">
      🎓 {t("bk.lesson", { coach: b.coachName ?? "", fee: money(b.coachFee ?? 0) })}
      {b.status === "confirmed" &&
        (b.coachOwed ?? []).map((o) =>
          act.paying === `coach:${o.changeId}` ? (
            <span key={o.changeId} className="mt-1 block">
              <MethodPicker
                label={t(o.pageOpenUntil ? "cp7.bk.closeAndTake" : "co6.bk.owedTakeBy", { amount: money(o.amount) })}
                onPick={(via) => act.collectCoachDifference(b, o.changeId, via, !!o.pageOpenUntil)}
                onCancel={() => act.setPaying(null)}
              />
            </span>
          ) : (
            <button
              key={o.changeId}
              onClick={() => act.setPaying(`coach:${o.changeId}`)}
              title={o.pageOpenUntil ? t("cp7.bk.payingTitle") : t("co6.bk.owedTitle", { coach: o.coach })}
              className="mt-1 block rounded bg-amber-50 px-2 py-0.5 text-left font-medium text-amber-800 ring-1 ring-amber-200"
            >
              {o.pageOpenUntil
                ? t("cp7.bk.paying", {
                    amount: money(o.amount),
                    coach: o.coach,
                    time: clockTime(new Date(o.pageOpenUntil), o.zone ?? region().timeZone, t.locale),
                  })
                : t("co6.bk.owed", { amount: money(o.amount), coach: o.coach })}
            </button>
          )
        )}
      {(b.coachPaid ?? []).map((p) => (
        <span key={p.changeId} title={t("cp7.bk.paidTitle")} className="mt-1 block text-emerald-700">
          ✓ {t("cp7.bk.paid", { amount: money(p.amount), coach: p.coach, via: viaName(t, p.via) })}
        </span>
      ))}
    </div>
  );
}

/** How a coach's difference was paid, in the staff member's language: a counter method, or online. */
function viaName(t: StaffT, via: string): string {
  return via in PAID_VIA_LABELS ? t(`c.via.${via as PaidVia}`) : via;
}

/** Strikes against this number here, where the venue counts them, with a way to let them off. */
function StrikesBadge({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  // Letting strikes off is a manager's (lib/roles.ts): front desk sees the count.
  const may = useStaffMay();
  if (!b.strikes || b.strikes.count === 0) return null;
  const out = b.strikes.count >= b.strikes.limit;
  const counts = { count: b.strikes.count, limit: b.strikes.limit };
  if (!may("strikes"))
    return (
      <span
        title={out ? t("bk.strikesTitleOut", counts) : t("bk.strikesTitle", counts)}
        className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${out ? "bg-red-600 text-white" : "bg-amber-100 text-amber-800"}`}
      >
        {t("bk.strikes", counts)}
      </span>
    );
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
  const clock = useStaffClock();
  if (b.status !== "confirmed") return <span className="text-xs text-slate-400">—</span>;
  // Held for payment online: it goes by itself if not paid in time.
  if (b.paymentStatus === "unpaid" && b.holdUntil)
    return (
      <span
        title={t("bk.heldTitle")}
        className={`${CHIP} bg-amber-50 text-amber-700 ring-1 ring-amber-200`}
      >
        {t("bk.heldTill", { time: clock.time(b.holdUntil, b.venueId) })}
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
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <MethodPicker
          label={series ? t("bk.seriesPaidBy", { series: b.seriesCode ?? "" }) : t("bk.paidBy")}
          onPick={(via) => (series ? act.paySeries(b.seriesCode!, via) : act.togglePaid(b.code, true, via))}
          onCancel={() => act.setPaying(null)}
        />
        {/* Or with passes: one for the booking, or each person's own for their place. Not a booking with extras. */}
        {!series && !b.addons?.length && <CounterPassPay code={b.code} act={act} />}
      </span>
    );
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
          setChoices(res.ok ? (await readJson(res)).accounts : []);
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

/**
 * Paying at the counter with passes (ADR 0025): the passes this number holds
 * here, and which pays for whom, as the booking engine will spend them
 * (components/PassAllocation.tsx, lib/pass-rules.ts); refused with the reason.
 */
function CounterPassPay({ code, act }: { code: string; act: Act }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{
    booking: { name: string; players: number };
    places: PlanPlace[];
    passes: AllocPass[];
    soldByPlace: boolean;
    minutes: number;
  } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function show() {
    setOpen(true);
    setError(null);
    const res = await fetch(`/api/admin/bookings/passes?code=${encodeURIComponent(code)}`, { cache: "no-store" });
    const body = await readJson(res);
    if (!res.ok) return setError(t.err(body, t("stk.bk.failed")));
    setData(body);
  }
  if (!open)
    return (
      <button type="button" onClick={show} className={`${CHIP} bg-sky-50 text-sky-700 ring-1 ring-sky-200 hover:bg-sky-100`}>
        {t("stk.bk.passes")}
      </button>
    );
  const chosen = passCodesOf(codes);
  const len = (minutes: number) => lengthLabel(t.customer, minutes);
  return (
    <span className="mt-1 block w-full rounded-md border border-sky-200 bg-sky-50 p-2" data-testid="counter-pass-pay">
      <span className="block text-xs font-semibold text-sky-800">{t("stk.bk.passesTitle")}</span>
      {data && data.passes.length === 0 && <span className="block text-xs text-slate-500">{t("stk.bk.none")}</span>}
      {data && data.passes.length > 0 && (
        <PassAllocation
          places={data.places}
          passes={data.passes}
          players={data.booking.players}
          minutes={data.minutes}
          soldByPlace={data.soldByPlace}
          bookerName={data.booking.name}
          codes={codes}
          onChange={setCodes}
          words={{
            title: t("stk.bk.passesTitle"),
            whole: t("stk.bk.wholeBooking"),
            each: t("stk.bk.each"),
            none: t("stk.bk.noPass"),
            option: (p) => (p.kind === "time" ? t("stk.bk.optionTime", { name: p.name, len: len(p.remaining) }) : t("stk.bk.option", { name: p.name, n: p.remaining })),
            uses: (p, units) =>
              p.kind === "time" ? t("stk.bk.usesTime", { len: len(units), left: len(p.remaining) }) : t("stk.bk.uses", { n: units, left: p.remaining }),
            short: t("stk.bk.short"),
            ready: t("stk.bk.ready"),
            explain: (plan) => (plan.code === "PASS_TOO_LONG" ? t("stk.bk.tooLong", { len: len(plan.maxMinutes) }) : errorText(t.customer, plan.code, plan.vars)),
          }}
        />
      )}
      {error && <span className="block text-xs font-medium text-red-700">{error}</span>}
      <span className="mt-1 flex gap-1">
        {chosen.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const refused = await act.payWithPasses(code, chosen);
              setBusy(false);
              if (refused) setError(refused);
            }}
            className={`${CHIP} bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50`}
          >
            {t("stk.bk.pay")}
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} aria-label={t("c.cancel")} className="px-1 text-xs text-slate-400 hover:text-slate-600">
          ✕
        </button>
      </span>
    </span>
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
  const clock = useStaffClock();
  if (b.status !== "confirmed") return <span className="text-xs text-slate-400">—</span>;
  if (b.checkedInAt)
    return (
      <button
        onClick={() => act.toggleCheckIn(b.code, !b.checkedOutAt)}
        title={
          b.checkedOutAt
            ? t("bk.leftAt", { time: clock.time(b.checkedOutAt, b.venueId) })
            : t("bk.arrived", { time: clock.time(b.checkedInAt, b.venueId) })
        }
        className={`${CHIP} ${
          b.checkedOutAt
            ? "bg-slate-100 text-slate-500"
            : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
        }`}
      >
        {b.checkedOutAt ? t("bk.left", { time: clock.time(b.checkedOutAt, b.venueId) }) : t("bk.in", { time: clock.time(b.checkedInAt, b.venueId) })}
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
        return <PlaceConcessionCheck key={c.id} b={b} act={act} id={c.id} concession={c.concessionName} name={name} amount={c.amount} />;
      })}
    </>
  );
}

/**
 * One person's concession at the counter: their own proof looked at. Seen, it
 * can be remembered for that person for a while, as a booking's own can
 * (lib/concessions.ts checkPlaceConcession); not shown, their place alone is
 * charged in full.
 */
function PlaceConcessionCheck({ b, act, id, concession, name, amount }: { b: AdminBookingRow; act: Act; id: number; concession: string; name: string; amount: number }) {
  const t = useStaffT();
  const [asking, setAsking] = useState(false);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-amber-800">
      🎫 {t("ent.bk.concDue", { concession, name, amount: money(amount) })}
      {!asking ? (
        <>
          <button type="button" onClick={() => setAsking(true)} className={`${CHIP} bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}>
            {t("ent.bk.proofSeen")}
          </button>
          <button type="button" onClick={() => act.checkPlaceConcession(b, id, "refused")} className={`${CHIP} bg-red-50 text-red-700 hover:bg-red-100`}>
            {t("ent.bk.noProof")}
          </button>
        </>
      ) : (
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
              type="button"
              onClick={() => act.checkPlaceConcession(b, id, "seen", value)}
              className={`${CHIP} bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200`}
            >
              {label}
            </button>
          ))}
          <button type="button" onClick={() => setAsking(false)} aria-label={t("c.cancel")} className="px-1 text-slate-400">
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

function KitChip({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  const clock = useStaffClock();
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
        title={t("bk.outTitle", { time: clock.time(b.hire.takenAt, b.venueId), amount: money(b.hire.deposit) })}
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
  // Blocking a number is a manager's (lib/roles.ts).
  const may = useStaffMay();
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
        onClick={() => act.openCorrect(b)}
        className="inline-flex min-h-7 items-center rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
      >
        {t("p8a.fix.action")}
      </button>
      <button
        onClick={() => act.cancelBooking(b.code)}
        className="inline-flex min-h-7 items-center rounded-md border border-red-300 px-2.5 text-xs font-medium text-red-600 hover:bg-red-50"
      >
        {t("c.cancel")}
      </button>
      {b.seriesCode && (
        <button
          onClick={() => act.openSeriesCancel(b.seriesCode!)}
          className="inline-flex min-h-7 items-center rounded-md border border-red-200 px-2.5 text-xs font-medium text-red-600 hover:bg-red-50"
        >
          {t("p8a.sx.action")}
        </button>
      )}
      {may("blockNumber") && (
        <button
          onClick={() => act.blockNumber(b)}
          title={t("bk.blockTitle")}
          className="inline-flex min-h-7 items-center rounded-md px-2 text-xs text-slate-400 hover:text-red-600"
        >
          {t("bk.blockNumber")}
        </button>
      )}
    </>
  );
}

/**
 * A row's actions in a compact menu (X1-18), so nothing is cut off at laptop
 * width. Each action closes the menu as it is chosen.
 */
function RowMenu({ b, act }: { b: AdminBookingRow; act: Act }) {
  const t = useStaffT();
  if (b.status !== "confirmed") return null;
  return (
    <details className="relative inline-block text-left">
      <summary className="inline-flex min-h-7 cursor-pointer list-none items-center rounded-md border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:border-teal-500">
        {t("p8a.day.actions")} ▾
      </summary>
      <div
        className="absolute right-0 z-20 mt-1 flex w-48 flex-col items-stretch gap-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg"
        onClick={(e) => (e.target as HTMLElement).closest("button") && e.currentTarget.parentElement?.removeAttribute("open")}
      >
        <RowActions b={b} act={act} />
      </div>
    </details>
  );
}

/** *New booking*: the venue's own booking page, where the counter books, on the day shown (X1-9). */
function NewBooking({ venues, date }: { venues: DayVenue[]; date: string }) {
  const t = useStaffT();
  if (venues.length === 0) return null;
  const link = "inline-flex min-h-10 items-center rounded-md bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700";
  if (venues.length === 1)
    return (
      <a href={`/venue/${venues[0].id}?date=${date}`} target="_blank" rel="noopener noreferrer" title={t("p8a.day.newBookingTitle")} className={link}>
        {t("p8a.day.newBooking")}
      </a>
    );
  return (
    <details className="relative">
      <summary className={`${link} cursor-pointer list-none`} title={t("p8a.day.newBookingTitle")}>
        {t("p8a.day.newBooking")} ▾
      </summary>
      <div className="absolute z-20 mt-1 flex w-64 flex-col rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
        {venues.map((v) => (
          <a key={v.id} href={`/venue/${v.id}?date=${date}`} target="_blank" rel="noopener noreferrer" className="rounded px-3 py-2 text-sm hover:bg-teal-50">
            {t("p8a.day.newBookingAt", { venue: v.name })}
          </a>
        ))}
      </div>
    </details>
  );
}

/** How one way of settling is said on its button. */
function optionLabel(t: StaffT, p: StaffCancelPreview, o: StaffCancelOption): string {
  if (o.outcome === "credit") return t("p8a.cx.credit", { amount: money(o.refund) });
  if (o.outcome === "keep")
    return o.refund > 0
      ? t("p8a.cx.keep", { kept: money(o.kept), pct: p.keptPercent ?? 0, amount: money(o.refund) })
      : t("p8a.cx.keepAll", { pct: p.keptPercent ?? 0 });
  if (o.refund <= 0) return t("p8a.cx.confirm");
  if (p.how === "counter" && p.deposit <= 0) return t("p8a.cx.backTill", { amount: money(o.refund), via: p.paidVia ? t(`c.via.${p.paidVia}`) : t("p8a.day.viaUnrecorded") });
  return t("p8a.cx.back", { amount: money(o.refund) });
}

/**
 * Cancelling a booking (X1-1): what was paid and how, the venue's terms as a
 * customer would meet them, and a button for each way to settle it. A counter
 * payment from an earlier day is a manager's to give back.
 */
function CancelPanel({
  preview: p,
  venueId,
  onChoose,
  onClose,
}: {
  preview: StaffCancelPreview;
  venueId: number | null;
  onChoose: (o: StaffCancelOption) => void;
  onClose: () => void;
}) {
  const t = useStaffT();
  const clock = useStaffClock();
  const amount = money(p.paid);
  const paidLine =
    p.how === "none"
      ? t("p8a.cx.unpaid")
      : p.how === "counter"
        ? p.paidVia
          ? t("p8a.cx.paidVia", { amount, via: t(`c.via.${p.paidVia}`), date: p.paidAt ? clock.when(p.paidAt, venueId) : "?" })
          : t("p8a.cx.paidCounter", { amount, date: p.paidAt ? clock.when(p.paidAt, venueId) : "?" })
        : p.how === "online"
          ? t("p8a.cx.paidOnline", { amount })
          : p.how === "credit"
            ? t("p8a.cx.paidCredit", { amount })
            : p.how === "pass"
              ? t("p8a.cx.paidPass")
              : t("p8a.cx.paidAccount");
  const terms = !p.late
    ? t("p8a.cx.inWindow", { n: p.cutoffHours })
    : p.keptPercent !== null
      ? t("p8a.cx.late", { n: p.cutoffHours, pct: p.keptPercent })
      : t("p8a.cx.lateNone", { n: p.cutoffHours });
  return (
    <div className="rounded-xl border border-red-200 bg-red-50/40 px-4 py-3 text-sm" data-testid="cancel-panel">
      <p className="font-semibold">{t("p8a.cx.title", { code: p.code })}</p>
      <p className="mt-1 text-slate-700">{paidLine}</p>
      {p.deposit > 0 && <p className="text-slate-700">{t("p8a.cx.deposit", { amount: money(p.deposit) })}</p>}
      <p className="text-slate-600">{terms}</p>
      {p.how === "counter" && p.paid > 0 && !p.account && <p className="text-xs text-slate-500">{t("p8a.cx.noAccount")}</p>}
      {p.managerOnly && <p className="mt-1 font-medium text-amber-800">{t("p8a.cx.managerOnly")}</p>}
      {p.kitOut ? (
        <p className="mt-1 font-medium text-amber-800">{t("p8a.cx.kitOut")}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {p.options.map((o) => (
            <button
              key={o.outcome}
              type="button"
              disabled={p.managerOnly && o.refund > 0}
              onClick={() => onChoose(o)}
              className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {optionLabel(t, p, o)}
            </button>
          ))}
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700">
            {t("p8a.cx.dont")}
          </button>
        </div>
      )}
      {p.how === "counter" && p.paid > 0 && !p.kitOut && <p className="mt-2 text-xs text-slate-500">{t("p8a.cx.tillNote")}</p>}
    </div>
  );
}

/** A week's way of settling for the outcome chosen: as chosen where the week offers it, else back as paid. */
function weekOption(w: StaffSeriesWeek, outcome: CancelOutcome): StaffCancelOption {
  return w.options.find((o) => o.outcome === outcome) ?? w.options[0];
}

/**
 * Cancelling weeks of a series (X1-10): each upcoming week on its own terms,
 * as the customer's series preview gives them, the weeks to go ticked, and how
 * what was paid is settled.
 */
function SeriesCancelPanel({
  state,
  onChange,
  onConfirm,
  onClose,
}: {
  state: { seriesCode: string; weeks: StaffSeriesWeek[]; chosen: string[]; outcome: CancelOutcome };
  onChange: (s: { seriesCode: string; weeks: StaffSeriesWeek[]; chosen: string[]; outcome: CancelOutcome }) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useStaffT();
  const chosen = state.weeks.filter((w) => state.chosen.includes(w.code));
  const back = chosen.reduce((sum, w) => sum + weekOption(w, state.outcome).refund, 0);
  const kept = chosen.reduce((sum, w) => sum + weekOption(w, state.outcome).kept, 0);
  return (
    <div className="rounded-xl border border-red-200 bg-red-50/40 px-4 py-3 text-sm" data-testid="series-cancel">
      <p className="font-semibold">{t("p8a.sx.title", { series: state.seriesCode })}</p>
      <p className="mt-0.5 text-xs text-slate-600">{t("p8a.sx.help")}</p>
      {state.weeks.length === 0 ? (
        <p className="mt-2 text-slate-600">{t("p8a.sx.none")}</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {state.weeks.map((w) => (
              <li key={w.code}>
                <label className="inline-flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!w.open}
                    checked={state.chosen.includes(w.code)}
                    onChange={(e) =>
                      onChange({ ...state, chosen: e.target.checked ? [...state.chosen, w.code] : state.chosen.filter((c) => c !== w.code) })
                    }
                  />
                  <span className="font-mono">{w.code}</span>
                  <span>
                    {w.date} {formatHour(w.startHour, t.locale)}–{formatHour(w.endHour, t.locale)}
                  </span>
                  <span className="text-slate-500">
                    {[
                      w.kitOut ? t("p8a.sx.kit") : w.late ? t("p8a.sx.late") : t("p8a.sx.free"),
                      w.paid > 0 ? t("p8a.sx.paid", { amount: money(w.paid) }) : t("p8a.sx.unpaid"),
                      w.managerOnly ? t("p8a.sx.manager") : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <fieldset className="mt-3 space-y-1 text-xs">
            <legend className="font-medium text-slate-600">{t("p8a.sx.how")}</legend>
            {(
              [
                ["back", t("p8a.sx.back")],
                ["credit", t("p8a.sx.credit")],
                ["keep", t("p8a.sx.keep")],
              ] as const
            ).map(([outcome, label]) => (
              <label key={outcome} className="mr-3 inline-flex items-center gap-1">
                <input type="radio" name="series-outcome" checked={state.outcome === outcome} onChange={() => onChange({ ...state, outcome })} />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="mt-2 text-xs text-slate-700">{t("p8a.sx.total", { n: chosen.length, amount: money(back), kept: money(kept) })}</p>
        </>
      )}
      <div className="mt-3 flex gap-2">
        {chosen.length > 0 && (
          <button type="button" onClick={onConfirm} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700">
            {t("p8a.sx.submit")}
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700">
          {t("p8a.cx.dont")}
        </button>
      </div>
    </div>
  );
}
