"use client";

import { activityIcon } from "@/lib/activity-registry";
import { accountDetour } from "@/lib/phone-detour";
import BookingTermsNotice from "@/components/BookingTermsNotice";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Booking, busyness, Court, CourtAvailability, isHire, isShared, MAX_RECUR_WEEKS, MAX_GROUP_COURTS, Sport, Pass, PublicPolicy, StartOption, VenueClosure } from "@/lib/types";
import { headedRows, placesPerBooking } from "@/lib/court-activities";
import { concessionWords } from "@/lib/concessions-shared";
import { pricedByQuantity } from "@/lib/pricing";
import { formatMinute, parseClock } from "@/lib/interval";
import { isPastSlot } from "@/lib/time";
import { lengthsUpTo, startLengths, startTakes } from "@/lib/booking-rules";
import { passCost } from "@/lib/pass-rules";
import WaiverTick from "@/components/WaiverTick";
import { explainGuard } from "@/components/ManagedPeople";
import { NeedsLabel, PeoplePerCourt, takingParam, useManagedPeople, useTaking, WhoTakesPart, whoBody } from "@/components/WhoTakesPart";
import { customerAnywhere, groupRequest, namedOn, splitByCourt, type CourtOf } from "@/lib/people-per-court";
import type { EligibilityLine } from "@/lib/eligibility";
import { ParticipantPicker, type PickedParticipant } from "@/components/admin/ParticipantPicker";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { sportLabel } from "@/lib/i18n";
import type { Phrase, T } from "@/lib/i18n";
import { downloadIcs, googleCalendarUrl, whatsappShareUrl } from "@/lib/booking-links";
import CheckInQr from "@/components/CheckInQr";
import PayOnline from "@/components/PayOnline";
import { SplitCost } from "@/components/SplitCost";
import AddonPicker, { pickedList, pickedTotal, type OfferedAddon, type Picked } from "@/components/AddonPicker";
import { forgetGuest, rememberedGuest, rememberGuest } from "@/lib/guest-memory";
import ChatLink from "@/components/ChatLink";
import { lengthLabel } from "@/lib/length-label";
import { money, intlTag, region, plainAmount, localTimeOf, shortDate } from "@/lib/region";

interface Props {
  venueId: number;
  /** For the box asking whether to hear from it. */
  venueName?: string;
  sports: Sport[];
  dates: string[];
  /** A booking to pre-select, e.g. when arriving from a search result: its start and length in minutes. */
  initial?: { sport?: Sport; date?: string; courtId?: number; start?: number; minutes?: number; heading?: string };
}

/** A selection on the "Any court" row, rather than on a named court. */
const ANY_COURT = -1;

/**
 * What is picked: a court (or any court), a start in minutes of the day, and
 * a length in minutes. The grid is a way of picking it; the booking is the
 * start and length, to the minute.
 */
interface Selection {
  courtId: number;
  start: number;
  length: number;
}

/** What the server says a booking would cost (/api/quote). */
interface Quote {
  total: number;
  court: number;
  fees: number;
  billedMinutes: number;
  allowed: boolean;
  error?: string;
  code?: string;
  vars?: Record<string, string | number>;
  others: { courtId: number; total: number; allowed: boolean }[];
}

interface Confirmation {
  booking: Booking;
  bookings: Booking[];
  skipped: { date: string; reason: string }[];
  seriesCode: string | null;
  court: Court;
  venue: { name: string; area: string; timeZone?: string };
  /** Total taken off by a promo code, and why one did not apply. */
  discount?: number;
  promoError?: string | null;
  /** The venue takes payment online, so the unpaid part can be paid now. */
  payOnline?: boolean;
  /** Extras on each booking, and why they could not go on. */
  addons?: { name: string; quantity: number; unitPrice: number }[];
  addonError?: { error: string; code?: string; vars?: Record<string, string | number> } | null;
  /** The platform's WhatsApp number, when customers can open the chat for their confirmation. */
  chatNumber?: string | null;
  /** The share the venue takes online to hold the booking, the rest at the counter. */
  depositPercent?: number | null;
  /** Courts booked together: each one's name, by id. */
  courtNames?: Record<number, string>;
  /** The concession price that went on, and what to bring for it; or why it did not. */
  concession?: { name: string; proof: string; preset?: string | null } | null;
  concessionError?: { error: string; code?: string; vars?: Record<string, string | number> } | null;
  /** Charged to a company or school account, on its monthly invoice. */
  account?: { name: string } | null;
}

/** A concession price the venue offers (lib/concessions.ts). */
interface Concession {
  id: number;
  name: string;
  percent: number;
  proof: string;
  sport: Sport | null;
  offPeakOnly: boolean;
  /** Built in and unchanged: its name and proof in the reader's language (lib/concessions-shared.ts). */
  preset?: string | null;
}

/** Cell colour by how full a shared facility is — the crowd signal. */
const BUSY_STYLES: Record<string, string> = {
  quiet: "bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
  filling: "bg-amber-50 text-amber-700 hover:bg-amber-100",
  busy: "bg-orange-100 text-orange-800 hover:bg-orange-200",
  full: "bg-slate-100 text-slate-300",
};

/**
 * The starts on the "Any court" row: every court's, each with the longest any
 * court allows from there, and the lengths any court takes where some court
 * lists them (joining a session on a facility turned over whole).
 */
function anyStarts(availability: CourtAvailability[]): StartOption[] {
  const best = new Map<number, number>();
  const listed = new Set<number>();
  for (const a of availability)
    for (const s of a.starts) {
      best.set(s.minute, Math.max(best.get(s.minute) ?? 0, s.maxLength));
      if (s.lengths) listed.add(s.minute);
    }
  const lengthsAt = (minute: number) =>
    [...new Set(availability.flatMap((a) => a.starts.filter((s) => s.minute === minute).flatMap((s) => startLengths(a.policy, s))))].sort((x, y) => x - y);
  return [...best]
    .sort((x, y) => x[0] - y[0])
    .map(([minute, maxLength]) => (listed.has(minute) ? { minute, maxLength, lengths: lengthsAt(minute) } : { minute, maxLength }));
}

/** The length to start with: the policy's usual one where it fits, else the longest that does. */
function firstLength(policy: PublicPolicy, option: StartOption): number | null {
  const lengths = startLengths(policy, option);
  if (lengths.length === 0) return null;
  return lengths.includes(policy.defaultLength) ? policy.defaultLength : lengths[lengths.length - 1];
}

/**
 * A taken cell can be queued for; a blocked, class-reserved, shut or past one
 * cannot, because no cancellation will ever free it. Past by the venue's clock.
 */
function canQueue(slot: CourtAvailability["slots"][number], date: string, zone: string): boolean {
  if (slot.available || slot.blocked || slot.className || slot.outside) return false;
  return !isPastSlot(date, slot.minute / 60, zone);
}

function formatDateLabel(t: T, date: string): { day: string; num: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const tag = intlTag(t.locale);
  return {
    day: d.toLocaleDateString(tag, { weekday: "short", timeZone: "UTC" }),
    num: shortDate(date, t.locale),
  };
}

export default function BookingBoard({ venueId, venueName = "", sports, dates, initial }: Props) {
  const t = useT();
  const [sport, setSport] = useState<Sport>(
    initial?.sport && sports.includes(initial.sport) ? initial.sport : sports[0]
  );
  const [date, setDate] = useState<string>(
    initial?.date && dates.includes(initial.date) ? initial.date : dates[0]
  );
  // Applied once, after the first availability load resolves.
  const pendingInitial = useRef(
    initial?.courtId && initial.start !== undefined ? { courtId: initial.courtId, start: initial.start, minutes: initial.minutes } : null
  );
  const [availability, setAvailability] = useState<CourtAvailability[] | null>(null);
  // Who is taking part, as chosen on the search page in this tab: each one's status beside what a court asks for.
  const { chosen, people } = useTaking({ lazy: true });
  const taking = takingParam(chosen);
  const [eligibility, setEligibility] = useState<Partial<Record<"signOff" | "certification", EligibilityLine[]>> | null>(null);
  const [closure, setClosure] = useState<VenueClosure | null>(null);
  const [memberRates, setMemberRates] = useState(false);
  // The venue's clock, which the times and "already passed" go by.
  const [zone, setZone] = useState(region().timeZone);
  // The most weeks one weekly booking may run at this venue.
  const [maxWeeks, setMaxWeeks] = useState(MAX_RECUR_WEEKS);
  // Concession prices offered here.
  const [concessions, setConcessions] = useState<Concession[]>([]);
  // A manager of this venue, who may book outside its rules.
  const [mayOverride, setMayOverride] = useState(false);
  // The venue's own staff, booking at the counter (lib/participant-bookings.ts).
  const [atCounter, setAtCounter] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Why the last booking did not go through. Kept apart from a load error,
  // since the grid reloads after a refusal and must not wipe the reason.
  const [bookingError, setBookingError] = useState<string | null>(null);
  // Something else picked: the reason the last try failed no longer applies.
  useEffect(() => setBookingError(null), [selection?.courtId, selection?.start, selection?.length, date]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [waitlistSlot, setWaitlistSlot] = useState<{
    court: Court;
    minute: number;
    length: number;
  } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Kinds of kit under one heading, arriving from search: that heading marked on the grid, and in view.
  const focusHeading = initial?.heading?.toLowerCase() ?? null;
  const startAsked = useRef(initial?.start);
  const headingShown = useRef(false);
  const showHeading = useCallback((row: HTMLTableRowElement | null) => {
    if (!row || headingShown.current) return;
    headingShown.current = true;
    row.scrollIntoView?.({ block: "nearest" });
  }, []);

  // Open the grid on the first time there is something to book (or on the
  // time already chosen, arriving from search), not on the venue's opening
  // hour. On a phone only a few columns fit; in the evening those are the
  // morning's, all past and greyed out, and the free ones are off to the right
  // where a first-time visitor will not think to look.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !availability || grid.scrollWidth <= grid.clientWidth) return;
    const cells = availability[0]?.slots ?? [];
    const width = availability[0]?.grid ?? 60;
    const firstFree = cells.find((c) => availability.some((a) => a.slots.find((s) => s.minute === c.minute)?.available))?.minute;
    const at = selection?.start ?? startAsked.current;
    startAsked.current = undefined;
    const chosen = at !== undefined ? cells.find((c) => c.minute <= at && at < c.minute + width)?.minute : undefined;
    const target = chosen ?? firstFree;
    if (target === undefined) return;
    const column = grid.querySelector<HTMLElement>(`th[data-minute="${target}"]`);
    const courtNames = grid.querySelector<HTMLElement>("th");
    if (column && courtNames) grid.scrollLeft = Math.max(column.offsetLeft - courtNames.offsetWidth, 0);
    // Only when a new day or sport is loaded, not on every tap of a cell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability]);

  const loadAvailability = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/availability?venueId=${venueId}&date=${date}&sport=${sport}${taking ? `&taking=${taking}` : ""}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("board.loadFailed"));
      const courts: CourtAvailability[] = data.availability;
      setAvailability(courts);
      setEligibility(data.eligibility ?? null);
      setClosure(data.closure ?? null);
      setMemberRates(data.memberRates === true);
      setMayOverride(data.mayOverride === true);
      setAtCounter(data.atCounter === true);
      if (typeof data.timeZone === "string") setZone(data.timeZone);
      if (Number.isInteger(data.seriesWeeks)) setMaxWeeks(data.seriesWeeks);
      setConcessions(Array.isArray(data.concessions) ? data.concessions : []);

      const pending = pendingInitial.current;
      if (pending) {
        pendingInitial.current = null;
        const court = courts.find((a) => a.court.id === pending.courtId);
        const option = court?.starts.find((s) => s.minute === pending.start);
        if (court && option) {
          const allowed = startLengths(court.policy, option);
          const length = pending.minutes !== undefined && allowed.includes(pending.minutes) ? pending.minutes : firstLength(court.policy, option);
          if (length) setSelection({ courtId: court.court.id, start: option.minute, length });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("board.loadFailed"));
      setAvailability(null);
      setClosure(null);
      setMemberRates(false);
    } finally {
      setLoading(false);
    }
  }, [venueId, date, sport, taking, t]);

  useEffect(() => {
    setSelection(null);
    loadAvailability();
  }, [loadAvailability]);

  const hasShared = useMemo(
    () => (availability ?? []).some((a) => a.court.capacity > 1),
    [availability]
  );

  /**
   * The rows in the order shown: kinds of the same thing under one heading
   * together, where the first of them was, the heading on the first of each.
   */
  const headed = useMemo(() => headedRows(availability ?? []), [availability]);

  /** The width of a column, in minutes: a way of showing the day, not what may be booked. */
  const grid = availability?.[0]?.grid ?? 60;

  /**
   * A row standing for "whichever court, pick the cheapest". Worth offering
   * only when there is more than one court to choose between.
   */
  const anyRow = useMemo(() => {
    if (!availability || availability.length < 2) return null;
    return availability[0].slots.map((cell, i) => {
      const free = availability.map((a) => a.slots[i]).filter((s) => s && s.minute === cell.minute && s.available);
      return {
        minute: cell.minute,
        available: free.length > 0,
        rate: free.length > 0 ? Math.min(...free.map((s) => s.rate)) : 0,
        courts: free.length,
      };
    });
  }, [availability]);

  /** The starts and rules of the court picked (or of "any court"). */
  const picked = useMemo(() => {
    if (!selection || !availability) return null;
    if (selection.courtId === ANY_COURT) {
      const first = availability[0];
      return first ? { starts: anyStarts(availability), policy: first.policy } : null;
    }
    const a = availability.find((x) => x.court.id === selection.courtId);
    return a ? { starts: a.starts, policy: a.policy } : null;
  }, [selection, availability]);

  const selectedCourt = useMemo(() => {
    if (selection?.courtId === ANY_COURT) {
      // A stand-in so the form below can stay unchanged; the submit path
      // sends venue + sport instead of this id.
      const first = availability?.[0]?.court;
      if (!first) return null;
      // How many it can be for: what every one of them allows, so whichever is
      // picked takes it (players on courts all priced per player, places on
      // resources that all have them), never a number one of them refuses.
      const courts = (availability ?? []).map((a) => a.court);
      const everyShared = courts.every((c) => c.capacity > 1);
      const everyPerPlayer = courts.every((c) => c.capacity === 1 && c.perPlayer);
      const fewestMost = Math.min(...courts.map((c) => placesPerBooking(c)));
      return {
        id: ANY_COURT,
        venueId: first.venueId,
        name: t("board.anyCourt"),
        sport: first.sport,
        offPeakRate: 0,
        peakRate: 0,
        capacity: everyShared ? Math.min(...courts.map((c) => c.capacity)) : 1,
        perPlayer: everyPerPlayer,
        maxPlayers: everyShared || everyPerPlayer ? fewestMost : null,
      } as Court;
    }
    return availability?.find((a) => a.court.id === selection?.courtId)?.court ?? null;
  }, [availability, selection, t]);

  /**
   * Others free for the same start and length, to book with it as one: other
   * whole courts beside a whole court, or other shared resources beside a
   * shared one (another kind of kit, each a fleet of its own). The other kinds
   * under the same heading as the one picked come first.
   */
  const alsoFree = useMemo(() => {
    if (!selection || !availability || selection.courtId === ANY_COURT) return [];
    const picked = availability.find((a) => a.court.id === selection.courtId)?.court;
    const shared = (picked?.capacity ?? 1) > 1;
    const sameHeading = (c: Court) => !!picked?.heading && c.heading?.toLowerCase() === picked.heading.toLowerCase();
    const free = headed
      .filter((a) => a.court.id !== selection.courtId && (a.court.capacity > 1) === shared)
      .filter((a) => lengthsUpTo(a.policy, selection.length).includes(selection.length))
      .filter((a) => {
        const option = a.starts.find((s) => s.minute === selection.start);
        return option !== undefined && startTakes(option, selection.length);
      })
      .map((a) => a.court);
    return [...free.filter(sameHeading), ...free.filter((c) => !sameHeading(c))];
  }, [selection, availability, headed]);

  /** The columns the selection covers, for showing it, and for what they say (peak, last-minute). */
  const coveredCells = useCallback(
    (courtId: number) => {
      if (!selection || !availability) return [];
      const row = courtId === ANY_COURT ? availability[0] : availability.find((a) => a.court.id === courtId);
      return (row?.slots ?? []).filter((c) => c.minute < selection.start + selection.length && c.minute + grid > selection.start);
    },
    [selection, availability, grid]
  );

  /** The last-minute discount on the time picked, if any: the form says what it is. */
  const lastMinute = useMemo(() => {
    if (!selection) return 0;
    return Math.max(0, ...coveredCells(selection.courtId).map((c) => c.lastMinute ?? 0));
  }, [selection, coveredCells]);

  /**
   * A tap on a cell. On a new court (or nothing picked yet), it picks the
   * first start in that cell, or the latest one before it that runs into it,
   * for the court's usual length. On the court already picked, a cell after
   * the start stretches the booking to end with that cell, as far as the
   * court's lengths and what is free allow; a cell inside it lets it go.
   */
  function tapCell(courtId: number, minute: number) {
    setError(null);
    const starts = courtId === ANY_COURT ? anyStarts(availability ?? []) : (availability?.find((a) => a.court.id === courtId)?.starts ?? []);
    const policy = (courtId === ANY_COURT ? availability?.[0] : availability?.find((a) => a.court.id === courtId))?.policy;
    if (!policy) return;
    setSelection((prev) => {
      if (prev && prev.courtId === courtId) {
        if (minute < prev.start + prev.length && minute + grid > prev.start) return null;
        if (minute >= prev.start + prev.length) {
          const from = starts.find((s) => s.minute === prev.start);
          const allowed = from ? startLengths(policy, from) : lengthsUpTo(policy, prev.length);
          const wanted = minute + grid - prev.start;
          const length = allowed.find((l) => l >= wanted) ?? allowed[allowed.length - 1];
          return length ? { ...prev, length } : prev;
        }
      }
      const option =
        starts.find((s) => s.minute >= minute && s.minute < minute + grid) ??
        [...starts].reverse().find((s) => s.minute < minute && s.minute + s.maxLength > minute);
      if (!option) return prev;
      const length = firstLength(policy, option);
      return length ? { courtId, start: option.minute, length } : prev;
    });
  }

  const startLabel = (minute: number) => formatMinute(minute).replace(":00 ", " ").replace(" ", "");

  return (
    <div className="space-y-5">
      {/* Sport tabs */}
      <div className="flex flex-wrap gap-2">
        {sports.map((s) => (
          <button
            key={s}
            onClick={() => setSport(s)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              s === sport
                ? "bg-teal-600 text-white shadow"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
            }`}
          >
            {activityIcon(s)} {sportLabel(t, s)}
          </button>
        ))}
      </div>

      {/* Date strip */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {dates.map((d) => {
          const { day, num } = formatDateLabel(t, d);
          return (
            <button
              key={d}
              onClick={() => setDate(d)}
              className={`min-w-[4.5rem] shrink-0 rounded-lg border px-2 py-2 text-center text-sm transition ${
                d === date
                  ? "border-teal-600 bg-teal-600 text-white shadow"
                  : "border-slate-200 bg-white text-slate-700 hover:border-teal-400"
              }`}
            >
              <div className="text-xs font-medium opacity-80">{day}</div>
              <div className="font-semibold">{num}</div>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {bookingError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {bookingError}
        </div>
      )}

      {closure && !loading && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>{t("board.closed", { date: closure.date })}</strong>{" "}
          {t("board.pickAnother")}
          {closure.reason && <div className="mt-0.5 text-amber-700">{closure.reason}</div>}
        </div>
      )}

      {memberRates && !loading && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-2.5 text-sm text-teal-800">
          <strong>{t("board.memberTitle")}</strong> {t("board.memberBody")}
        </div>
      )}

      {/* Availability grid */}
      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          {t("board.loading")}
        </div>
      ) : availability && availability.length > 0 ? (
        <div ref={gridRef} className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-semibold">
                  {t("board.court")}
                </th>
                {availability[0].slots.map((slot) => (
                  <th key={slot.minute} data-minute={slot.minute} className="px-1 py-2 text-center font-medium text-slate-500">
                    {startLabel(slot.minute)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {anyRow && (
                <tr className="border-b border-slate-200 bg-teal-50/40">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-teal-50 px-3 py-2 font-medium">
                    {t("board.anyCourt")}
                    <span className="block text-xs font-normal text-slate-500">
                      {t("board.anyCourtHint")}
                    </span>
                  </td>
                  {anyRow.map((slot) => {
                    const isSelected =
                      selection?.courtId === ANY_COURT && slot.minute < selection.start + selection.length && slot.minute + grid > selection.start;
                    return (
                      <td key={slot.minute} className="p-1 text-center">
                        <button
                          disabled={!slot.available && !isSelected}
                          onClick={() => tapCell(ANY_COURT, slot.minute)}
                          title={
                            slot.available
                              ? t.plural("board.anyFree", slot.courts, {
                                  time: formatMinute(slot.minute),
                                  rate: slot.rate,
                                })
                              : t("board.anyNone")
                          }
                          className={`h-9 w-11 rounded-md text-xs font-medium transition ${
                            isSelected
                              ? "bg-teal-600 text-white shadow"
                              : !slot.available
                                ? "cursor-not-allowed bg-slate-100 text-slate-300"
                                : "bg-teal-100 text-teal-800 hover:bg-teal-200"
                          }`}
                        >
                          {slot.available || isSelected ? (slot.rate === 0 ? t("price.free") : plainAmount(slot.rate)) : "—"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              )}
              {headed.map(({ court, slots, heading, under, policy }) => (
                <Fragment key={court.id}>
                {heading && (
                  // Kinds of the same thing under one heading: "Kayaks", then each kind.
                  <tr
                    className="border-b border-slate-100 bg-slate-50/60"
                    data-testid={`heading-${court.id}`}
                    data-focus={focusHeading === heading.toLowerCase() ? "true" : undefined}
                    ref={focusHeading === heading.toLowerCase() ? showHeading : undefined}
                  >
                    <th
                      scope="rowgroup"
                      colSpan={slots.length + 1}
                      className={`sticky left-0 z-10 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide ${
                        focusHeading === heading.toLowerCase() ? "bg-amber-100 text-amber-900" : "bg-slate-50 text-slate-600"
                      }`}
                    >
                      {heading}
                    </th>
                  </tr>
                )}
                <tr className="border-b border-slate-100 last:border-0">
                  <td className={`sticky left-0 z-10 whitespace-nowrap bg-white py-2 pr-3 font-medium ${under ? "pl-6" : "pl-3"}`}>
                    {court.name}
                    <div className="text-xs font-normal text-slate-400">
                      {court.offPeakRate === 0 && court.peakRate === 0
                        ? t("price.free")
                        : t(court.perPlayer ? "board.rateRangePlayer" : "board.rateRange", { from: court.offPeakRate, to: plainAmount(court.peakRate) })}
                      {isShared(court) && ` · ${t("board.places", { n: court.capacity })}`}
                      {isHire(court) && ` · ${t("board.depositLine", { amount: court.deposit })}`}
                    </div>
                    {/* What its rules ask for first, as search says it. */}
                    {policy.needs && (
                      <NeedsLabel t={t} needs={policy.needs} lines={eligibility?.[policy.needs]} people={people} variant="line" />
                    )}
                  </td>
                  {slots.map((slot) => {
                    const isSelected =
                      selection?.courtId === court.id && slot.minute < selection.start + selection.length && slot.minute + grid > selection.start;
                    const shared = isShared(court);
                    const left = slot.capacity - slot.booked;
                    const level = busyness(slot.booked, slot.capacity);
                    const queue = canQueue(slot, date, zone);
                    // Partly held: a booking may still start in it, or run into it.
                    const pickable = slot.available || (slot.partly === true && !slot.outside);
                    return (
                      <td key={slot.minute} className="p-1 text-center">
                        <button
                          disabled={!pickable && !queue && !isSelected}
                          onClick={() =>
                            pickable || isSelected
                              ? tapCell(court.id, slot.minute)
                              : setWaitlistSlot({ court, minute: slot.minute, length: grid })
                          }
                          title={
                            slot.partly
                              ? t("board.partlyHint")
                              : !slot.available
                                ? queue
                                  ? t("board.queueHint")
                                  : slot.className
                                    ? t("board.reservedFor", { name: slot.className })
                                    : t("board.unavailable")
                                : shared
                                  ? t("board.sharedSlot", {
                                      time: formatMinute(slot.minute),
                                      rate: slot.rate,
                                      left,
                                      capacity: slot.capacity,
                                      level: t(`busy.${level}` as Phrase),
                                    })
                                  : t("board.plainSlot", {
                                      time: formatMinute(slot.minute),
                                      rate: slot.rate,
                                    })
                          }
                          className={`h-9 w-11 rounded-md text-xs font-medium transition ${
                            isSelected
                              ? "bg-teal-600 text-white shadow"
                              : slot.partly
                                ? "bg-gradient-to-r from-emerald-50 to-slate-100 text-emerald-700 hover:from-emerald-100"
                                : !slot.available
                                  ? queue
                                    ? "cursor-pointer bg-slate-100 text-slate-400 hover:bg-amber-100 hover:text-amber-700"
                                    : "cursor-not-allowed bg-slate-100 text-slate-300"
                                  : shared
                                    ? BUSY_STYLES[level]
                                    : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          }`}
                        >
                          {slot.partly
                            ? "½"
                            : !slot.available
                              ? queue
                                ? "+"
                                : "—"
                              : shared
                                ? left
                                : slot.rate === 0
                                  ? t("price.free")
                                  : plainAmount(slot.rate)}
                          {slot.available && slot.lastMinute && (
                            <span className={`block text-[9px] font-semibold leading-none ${isSelected ? "text-white" : "text-amber-700"}`}>
                              {t("lm.badge", { n: slot.lastMinute })}
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            <span>
              <span className="mr-1 inline-block h-3 w-3 rounded bg-emerald-100 align-middle" />
              {t("board.legendCell", { len: lengthLabel(t, grid) })}
            </span>
            <span>
              <span className="mr-1 inline-block h-3 w-3 rounded bg-gradient-to-r from-emerald-100 to-slate-100 align-middle" />
              {t("board.legendPartly")}
            </span>
            {hasShared && (
              <span>
                <span className="mr-1 inline-block h-3 w-3 rounded bg-amber-100 align-middle" />
                {t("board.legendShared")}
              </span>
            )}
            <span>
              <span className="mr-1 inline-block h-3 w-3 rounded bg-teal-600 align-middle" />
              {t("board.legendSelected")}
            </span>
            <span>
              <span className="mr-1 inline-block h-3 w-3 rounded bg-slate-100 align-middle" />
              {t("board.legendTaken")}
            </span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          {t("board.noCourts", { sport: sportLabel(t, sport).toLowerCase() })}
        </div>
      )}

      {/* Booking bar */}
      {selection && selectedCourt && picked && (
        <BookingForm
          t={t}
          venueName={venueName}
          court={selectedCourt}
          date={date}
          selection={selection}
          starts={picked.starts}
          policy={picked.policy}
          mayOverride={mayOverride && selection.courtId !== ANY_COURT}
          atCounter={atCounter}
          onChange={setSelection}
          maxWeeks={maxWeeks}
          alsoFree={alsoFree}
          concessions={concessions.filter(
            (c) =>
              (c.sport === null || c.sport === selectedCourt.sport) &&
              !(c.offPeakOnly && coveredCells(selection.courtId).some((cell) => cell.peak))
          )}
          lastMinute={lastMinute}
          onBooked={(c) => {
            setBookingError(null);
            setConfirmation(c);
            setSelection(null);
            loadAvailability();
          }}
          onError={(msg) => {
            setBookingError(msg);
            loadAvailability();
          }}
        />
      )}

      {waitlistSlot && (
        <SlotWaitlistModal
          t={t}
          court={waitlistSlot.court}
          date={date}
          minute={waitlistSlot.minute}
          length={waitlistSlot.length}
          onClose={() => setWaitlistSlot(null)}
        />
      )}

      {confirmation && (
        <ConfirmationModal t={t} confirmation={confirmation} onClose={() => setConfirmation(null)} />
      )}
    </div>
  );
}

function BookingForm({
  t,
  venueName,
  court,
  date,
  selection,
  starts,
  policy,
  mayOverride = false,
  atCounter = false,
  onChange,
  maxWeeks = MAX_RECUR_WEEKS,
  alsoFree = [],
  concessions = [],
  lastMinute = 0,
  onBooked,
  onError,
}: {
  t: T;
  venueName: string;
  court: Court;
  date: string;
  selection: Selection;
  /** Where a booking may start on this court, and the longest from each. */
  starts: StartOption[];
  /** What this court allows: lengths, and its usual one. */
  policy: PublicPolicy;
  /** A manager of this venue, who may book outside its rules. */
  mayOverride?: boolean;
  /** The venue's own staff at the counter, who may book for a child the venue knows (lib/participant-bookings.ts). */
  atCounter?: boolean;
  onChange: (s: Selection) => void;
  /** The most weeks one weekly booking may run here. */
  maxWeeks?: number;
  /** Other courts free for the same time, to book with this one as one. */
  alsoFree?: Court[];
  /** Concession prices that apply to this time on this court. */
  concessions?: Concession[];
  /** Percent off the time picked, for booking it now. */
  lastMinute?: number;
  onBooked: (c: Confirmation) => void;
  onError: (msg: string) => void;
}) {
  const { start, length } = selection;
  const end = start + length;
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // News from this venue: asked, never ticked for them (lib/marketing.ts).
  const [marketing, setMarketing] = useState(false);
  const [weeks, setWeeks] = useState(1);
  // Other courts booked with this one, at the same time.
  const [more, setMore] = useState<number[]>([]);
  // How many from each other shared resource chosen (another kind of kit).
  const [moreCount, setMoreCount] = useState<Record<number, number>>({});
  useEffect(() => {
    setMore([]);
    setMoreCount({});
  }, [court.id, start, length, date]);
  const moreChosen = alsoFree.filter((c) => more.includes(c.id));
  // Other kinds under the same heading as this one ("Kayaks"): offered first, and the list opens on them.
  const kindsUnderHeading = !!court.heading && alsoFree.some((c) => c.heading?.toLowerCase() === court.heading!.toLowerCase());
  const countOf = (c: Court) => moreCount[c.id] ?? 1;
  // A manager booking outside the court's rules: any start, any length; what holds the court still decides.
  const [override, setOverride] = useState(false);
  // A concession price: that share off the court time, shown at the counter.
  const [concessionId, setConcessionId] = useState<number | null>(null);
  const concession = concessions.find((c) => c.id === concessionId) ?? null;
  // How many: players on a court priced per player, or places on a shared
  // facility (people on a gym floor, kayaks from a fleet); the price is for each.
  const shared = court.capacity > 1;
  const [players, setPlayers] = useState(shared ? 1 : 2);
  const mostPlayers = placesPerBooking(court);
  const counted = mostPlayers > 1;

  // People the signed-in adult manages, booked for by them (lib/participant-bookings.ts; ADR 0023):
  // each ticked takes a place, and the adult one too where they take part.
  const [people, setPeople] = useState<{ id: number; displayName: string }[]>([]);
  const [forIds, setForIds] = useState<number[]>([]);
  const [meToo, setMeToo] = useState(true);
  // At the counter: children the venue knows with a guardian on this number, chosen by staff.
  const [counterPeople, setCounterPeople] = useState<PickedParticipant[]>([]);
  const [holderToo, setHolderToo] = useState(false);
  const named = atCounter ? counterPeople.map((p) => p.id) : forIds;
  const customerTakesPart = atCounter ? holderToo : meToo;
  // Several courts: who is on which (lib/people-per-court.ts), each person on one, the first court unless moved.
  const [courtOf, setCourtOf] = useState<CourtOf>({});
  const groupIds = moreChosen.length > 0 ? [court.id, ...moreChosen.map((c) => c.id)] : null;
  const split = groupIds ? splitByCourt({ courtIds: groupIds, named, customerTakesPart, courtOf }) : null;
  // On this court: everybody named, or in a group those on it (nobody named there: the party, as many as said).
  const persons = split ? Math.max(1, namedOn(split[0])) : named.length + (named.length === 0 || customerTakesPart ? 1 : 0);
  // Booked only for others: a membership does not price it (docs/features/pricing.md#memberships-and-member-rates).
  const forOthers = named.length > 0 && (split ? !customerAnywhere(split) : !customerTakesPart);
  // The price, as the server will charge it: worked out there, shown before booking.
  const [quote, setQuote] = useState<Quote | null>(null);
  const moreKey = moreChosen.map((c) => (c.capacity > 1 ? `${c.id}:${countOf(c)}` : String(c.id))).join(",");
  useEffect(() => {
    let live = true;
    setQuote(null);
    // The activity too: a court booked for several is priced for the one picked.
    const where = court.id === ANY_COURT ? `venueId=${court.venueId}&sport=${court.sport}` : `courtId=${court.id}&sport=${court.sport}`;
    const timer = setTimeout(() => {
      fetch(
        `/api/quote?${where}&date=${date}&start=${start}&end=${end}${counted ? `&players=${players}` : ""}${moreKey ? `&also=${moreKey}` : ""}${forOthers ? "&forOthers=1" : ""}`,
        { cache: "no-store" }
      )
        .then((res) => res.json())
        .then((data) => live && typeof data.total === "number" && setQuote({ others: [], ...data }))
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [court.id, court.venueId, court.sport, counted, date, start, end, players, moreKey, forOthers]);
  const othersTotal = (quote?.others ?? []).filter((o) => more.includes(o.courtId)).reduce((sum, o) => sum + o.total, 0);
  const off = (concession?.percent ?? 0) / 100;
  // A concession is off the court time, not a setup or cleanup fee.
  const totalPrice = quote
    ? Math.round((quote.court * (1 - off) + quote.fees + othersTotal * (1 - off)) * 100) / 100
    : null;
  const optionAt = starts.find((s) => s.minute === start);
  const lengths = optionAt ? startLengths(policy, optionAt) : lengthsUpTo(policy, length);
  const [balance, setBalance] = useState<number | null>(null);
  const [payFromWallet, setPayFromWallet] = useState(false);
  const [passCode, setPassCode] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [myPasses, setMyPasses] = useState<Pass[]>([]);
  const chosenPass = myPasses.find((p) => p.code === passCode) ?? null;
  const passSpend = chosenPass ? passCost(chosenPass, length) : null;
  // Company or school accounts here this customer may charge to (lib/accounts.ts).
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  const [chargeTo, setChargeTo] = useState<number | null>(null);
  // The venue's waiver, where it has one (lib/waivers.ts).
  const [agreeWaiver, setAgreeWaiver] = useState(false);
  const [skipConflicts, setSkipConflicts] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [remembered, setRemembered] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked>({});
  const [offered, setOffered] = useState<OfferedAddon[]>([]);
  const extras = pickedTotal(offered, picked);
  const withExtras = totalPrice === null ? null : Math.round((totalPrice + extras) * 100) / 100;
  const hasExtras = pickedList(picked).length > 0;

  // Prefill contact details: from the account, or from this device's last booking.
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!data.user) {
          const guest = rememberedGuest();
          if (guest) {
            setName((v) => v || guest.name);
            setPhone((v) => v || guest.phone);
            setEmail((v) => v || guest.email);
            setRemembered(guest.name);
          }
          return;
        }
        setSignedIn(true);
        setName((v) => v || data.user.name);
        setPhone((v) => v || data.user.phone);
        setEmail((v) => v || data.user.email);
        fetch(`/api/my/accounts?venueId=${court.venueId}`, { cache: "no-store" })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => data && setAccounts(data.accounts))
          .catch(() => {});
        fetch("/api/my/people", { cache: "no-store" })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => data && setPeople(data.people))
          .catch(() => {});
        return fetch(`/api/my/wallet?venueId=${court.venueId}`, { cache: "no-store" });
      })
      .then((res) => (res && res.ok ? res.json() : null))
      .then((wallet) => {
        if (wallet) setBalance(wallet.balance);
        return fetch("/api/my/passes", { cache: "no-store" });
      })
      .then((res) => (res && res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        // Only passes that could actually pay for this court.
        setMyPasses(
          (data.passes as Pass[]).filter(
            (p) =>
              !p.unusableReason &&
              p.venueId === court.venueId &&
              (p.sport === null || p.sport === court.sport)
          )
        );
      })
      .catch(() => {});
  }, [court.venueId, court.sport]);

  // A place for each person named, at least (a place is never shared by two people).
  useEffect(() => {
    if (counted && players < persons) setPlayers(Math.min(persons, mostPlayers));
  }, [counted, persons, players, mostPlayers]);
  // On another shared resource of a group, likewise for those put on it.
  const splitKey = split ? split.map((c) => `${c.courtId}:${namedOn(c)}`).join(",") : "";
  useEffect(() => {
    if (!split) return;
    const short = moreChosen.filter((c) => c.capacity > 1 && countOf(c) < namedOn(split.find((x) => x.courtId === c.id)!));
    if (short.length > 0)
      setMoreCount((was) => ({
        ...was,
        ...Object.fromEntries(short.map((c) => [c.id, Math.min(placesPerBooking(c), namedOn(split.find((x) => x.courtId === c.id)!))])),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitKey]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!atCounter && forIds.length === 0 && !meToo) {
      onError(t("pbk.nobody"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // ANY_COURT means "you pick": send the venue and sport instead.
          ...(court.id === ANY_COURT
            ? { venueId: court.venueId, sport: court.sport }
            : { courtId: court.id, sport: court.sport }),
          date,
          start,
          end,
          ...(override ? { override: true } : {}),
          name,
          phone,
          email,
          weeks,
          skipConflicts,
          // On an account, paid on its invoice: not from credit or a pass.
          payFromWallet: chargeTo === null && (hasExtras || passCode.trim() === "") && payFromWallet,
          payWithPass: (chargeTo === null && !hasExtras && passCode.trim()) || undefined,
          ...(chargeTo !== null ? { chargeTo } : {}),
          ...(agreeWaiver ? { agreeWaiver: true } : {}),
          // On several courts, each court's own people; otherwise everybody on this one.
          ...(groupIds
            ? groupRequest({
                courtIds: groupIds,
                named,
                customerTakesPart,
                courtOf,
                places: Object.fromEntries(moreChosen.filter((c) => c.capacity > 1).map((c) => [c.id, countOf(c)])),
              })
            : named.length > 0
              ? { participantIds: named, customerTakesPart }
              : {}),
          promoCode: promoCode.trim() || undefined,
          addons: pickedList(picked),
          marketing: email.trim() !== "" && marketing,
          ...(concession ? { concessionId: concession.id } : {}),
          ...(counted ? { players } : {}),
        }),
      });
      const data = await res.json();
      // Back to this very selection once the phone is sorted out.
      if (
        !res.ok &&
        court.id !== ANY_COURT &&
        accountDetour(data, `/venue/${court.venueId}?date=${date}&sport=${court.sport}&court=${court.id}&start=${start}&minutes=${length}`)
      )
        return;
      if (!res.ok && accountDetour(data)) return;
      if (!res.ok && typeof data?.code === "string" && (data.code.startsWith("GUARD_") || data.code.startsWith("PBK_"))) throw new Error(explainGuard(t, data));
      if (!res.ok) throw new Error(translateError(t, data) || t("form.failed"));
      if (!signedIn) rememberGuest({ name, phone, email });
      onBooked(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : t("form.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      // Above the grid's sticky court names, which would otherwise draw over it on a phone.
      className="sticky bottom-4 z-20 rounded-xl border border-teal-200 bg-white p-4 shadow-lg"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <div className="font-semibold text-teal-700">{court.heading ? `${court.heading} · ${court.name}` : court.name}</div>
          <div className="text-sm text-slate-600">
            {date} · {formatMinute(start)} – {formatMinute(end)} · {lengthLabel(t, length)} ·{" "}
            <span className="font-semibold text-slate-900">
              {withExtras === null ? t("quote.loading") : withExtras === 0 ? t("price.free") : `${money(withExtras)}`}
            </span>
          </div>
          {quote && quote.fees > 0 && <div className="text-xs text-slate-500">{t("quote.fees", { amount: quote.fees })}</div>}
          {quote && quote.billedMinutes !== length && quote.billedMinutes > 0 && (
            <div className="text-xs text-slate-500">{t("quote.billed", { len: lengthLabel(t, quote.billedMinutes) })}</div>
          )}
          {quote && !quote.allowed && !override && <div className="text-xs font-medium text-amber-700">{translateError(t, quote)}</div>}
          {remembered && (
            <button
              type="button"
              onClick={() => {
                forgetGuest();
                setRemembered(null);
                setName("");
                setPhone("");
                setEmail("");
              }}
              className="text-xs text-slate-500 underline"
            >
              {t("guest.notYou", { name: remembered })}
            </button>
          )}
          {isHire(court) && (
            <div className="text-xs text-amber-700">
              {t("form.depositNote", { amount: court.deposit })}
            </div>
          )}
        </div>
        <TimePicker
          t={t}
          selection={selection}
          starts={starts}
          lengths={lengths}
          override={override}
          onChange={onChange}
        />
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("form.name")}
          <input
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("auth.namePlaceholder")}
            className="mt-1 w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("form.phone")}
          <input
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("auth.phonePlaceholder")}
            className="mt-1 w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("form.emailOptional")}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("auth.emailPlaceholder")}
            className="mt-1 w-44 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          />
        </label>
        {more.length === 0 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("form.repeat")}
          <select
            value={weeks}
            onChange={(e) => setWeeks(Number(e.target.value))}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          >
            <option value={1}>{t("form.justOnce")}</option>
            {Array.from({ length: maxWeeks - 1 }, (_, i) => i + 2).map((w) => (
              <option key={w} value={w}>
                {t("form.weekly", { n: w })}
              </option>
            ))}
          </select>
        </label>
        )}
        <button
          type="submit"
          disabled={submitting || withExtras === null || (quote !== null && !quote.allowed && !override)}
          className="rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white shadow transition hover:bg-teal-700 disabled:opacity-50"
        >
          {submitting
            ? t("form.booking")
            : weeks > 1
              ? t("form.bookWeeks", { weeks, amount: withExtras ?? 0 })
              : t("form.book", { amount: withExtras ?? 0 })}
        </button>
      </div>
      {counted && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <label className="flex items-center gap-2">
            {t(shared ? "form.places" : "form.players")}
            {mostPlayers > 30 ? (
              // A venue that lets one booking take dozens: a number, not a list of them.
              <input
                type="number"
                min={1}
                max={mostPlayers}
                value={players}
                onChange={(e) => setPlayers(Math.max(1, Math.min(mostPlayers, Math.floor(Number(e.target.value)) || 1)))}
                className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
              />
            ) : (
              <select
                value={players}
                onChange={(e) => setPlayers(Number(e.target.value))}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
              >
                {Array.from({ length: mostPlayers }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
          </label>
          {quote && pricedByQuantity(court) && (
            <span className="text-slate-500">{t(shared ? "form.placesNote" : "form.playersNote", { n: players, price: money(quote.court / players) })}</span>
          )}
        </div>
      )}
      {concessions.length > 0 && (
        <div className="mt-2 text-xs text-slate-600">
          <label className="flex flex-wrap items-center gap-2">
            {t("form.price")}
            <select
              value={concessionId ?? ""}
              onChange={(e) => setConcessionId(e.target.value === "" ? null : Number(e.target.value))}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            >
              <option value="">{t("form.standardPrice")}</option>
              {concessions.map((c) => (
                <option key={c.id} value={c.id}>
                  {t("form.concessionOption", { name: concessionWords(t, c).name, pct: c.percent })}
                </option>
              ))}
            </select>
          </label>
          {concession && <p className="mt-1 font-medium text-amber-800">{t("form.concessionProof", { proof: concessionWords(t, concession).proof })}</p>}
        </div>
      )}
      {alsoFree.length > 0 && weeks === 1 && !hasExtras && (
        <details className="mt-2 text-xs text-slate-600" open={more.length > 0 || kindsUnderHeading}>
          <summary className="cursor-pointer font-medium text-teal-700">
            {kindsUnderHeading && court.heading
              ? t("pre.alsoKindsOf", { heading: court.heading })
              : t(shared ? "form.alsoBookKinds" : "form.alsoBook")}
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {alsoFree.map((c) => {
              const price = quote?.others.find((o) => o.courtId === c.id)?.total;
              return (
                <label key={c.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="accent-teal-600"
                    checked={more.includes(c.id)}
                    // The most courts booked together, this one included.
                    disabled={!more.includes(c.id) && more.length + 1 >= MAX_GROUP_COURTS}
                    onChange={(e) => setMore(e.target.checked ? [...more, c.id] : more.filter((id) => id !== c.id))}
                  />
                  {c.name}
                  {c.capacity > 1 && more.includes(c.id) && (
                    <input
                      type="number"
                      min={1}
                      max={placesPerBooking(c)}
                      value={countOf(c)}
                      aria-label={t("form.howMany", { name: c.name })}
                      data-testid={`more-count-${c.id}`}
                      onChange={(e) => setMoreCount({ ...moreCount, [c.id]: Math.max(1, Math.min(placesPerBooking(c), Number(e.target.value) || 1)) })}
                      className="w-12 rounded border border-slate-300 px-1 py-0.5"
                    />
                  )}
                  {price !== undefined && ` · ${price === 0 ? t("price.free") : money(price)}`}
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-slate-500">{t("form.alsoBookNote")}</p>
        </details>
      )}
      {mayOverride && (
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="accent-teal-600" />
          {t("form.override")}
        </label>
      )}
      {more.length === 0 && (
      <AddonPicker
        t={t}
        query={`${court.id === ANY_COURT ? `venueId=${court.venueId}&sport=${court.sport}` : `courtId=${court.id}`}&date=${date}&start=${start}&end=${end}`}
        picked={picked}
        onChange={setPicked}
        onList={setOffered}
      />
      )}
      {!atCounter && (
        <WhoTakesPart
          t={t}
          people={people}
          ids={forIds}
          meToo={meToo}
          onChange={(ids, me) => {
            setForIds(ids);
            setMeToo(me);
          }}
        />
      )}
      {atCounter && (
        <ParticipantPicker
          venueId={court.venueId}
          phone={phone}
          guardianName={name}
          many={{
            values: counterPeople,
            holderTakesPart: holderToo,
            onChange: (values, holder) => {
              setCounterPeople(values);
              setHolderToo(holder);
            },
          }}
        />
      )}
      {groupIds && (
        <PeoplePerCourt
          t={t}
          courts={[court, ...moreChosen].map((c) => ({ id: c.id, name: c.name }))}
          people={atCounter ? counterPeople : people.filter((p) => forIds.includes(p.id))}
          customer={customerTakesPart}
          customerLabel={t(atCounter ? "pbk2.holder" : "pbk2.me")}
          courtOf={courtOf}
          onChange={setCourtOf}
        />
      )}
      <WaiverTick venueId={court.venueId} venueName={venueName} checked={agreeWaiver} onChange={setAgreeWaiver} />
      {accounts.length > 0 && (
        <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          {t("form.whoPays")}
          <select
            value={chargeTo ?? ""}
            onChange={(e) => setChargeTo(e.target.value === "" ? null : Number(e.target.value))}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
          >
            <option value="">{t("form.payMyself")}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {t("form.onAccount", { name: a.name })}
              </option>
            ))}
          </select>
        </label>
      )}
      {chargeTo === null && balance !== null && balance > 0 && (hasExtras || passCode.trim() === "") && (
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={payFromWallet}
            onChange={(e) => setPayFromWallet(e.target.checked)}
            className="accent-teal-600"
          />
          {t("form.payFromCredit", { amount: balance })}
        </label>
      )}

      {/* One discount at a time: a concession price is one. */}
      {!concession && (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <label htmlFor="promo-code">{t("form.promoLabel")}</label>
        <input
          id="promo-code"
          value={promoCode}
          onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
          placeholder="RAYA20"
          className="w-32 rounded-md border border-slate-300 px-2 py-1 font-mono focus:border-teal-500 focus:outline-none"
        />
        {promoCode.trim() !== "" && (
          <span className="text-slate-500">{t("form.promoChecked")}</span>
        )}
      </div>
      )}

      {/* A pass settles the whole booking: entries or minutes of court time, by
          its own rule — court time only, so not a booking with extras. Not on an
          account, which pays on its invoice. */}
      {chargeTo !== null ? null : hasExtras ? (
        (myPasses.length > 0 || passCode.trim() !== "") && (
          <p className="mt-2 text-xs text-slate-500">{t("err.PASS_NOT_FOR_EXTRAS")}</p>
        )
      ) : (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span>{t("form.passLabel")}</span>
        {myPasses.length > 0 ? (
          <select
            value={passCode}
            onChange={(e) => setPassCode(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 focus:border-teal-500 focus:outline-none"
          >
            <option value="">{t("form.passNone")}</option>
            {myPasses.map((p) => (
              <option key={p.id} value={p.code}>
                {p.kind === "time" ? t("form.passOptionTime", { name: p.name, len: lengthLabel(t, p.remaining) }) : t("form.passOption", { name: p.name, n: p.remaining })}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={passCode}
            onChange={(e) => setPassCode(e.target.value.toUpperCase())}
            placeholder="PS-XXXXXX"
            className="w-36 rounded-md border border-slate-300 px-2 py-1 font-mono focus:border-teal-500 focus:outline-none"
          />
        )}
        {passSpend && !passSpend.ok && <span className="font-medium text-amber-700">{t("form.passTooLong", { len: lengthLabel(t, passSpend.maxMinutes) })}</span>}
        {passSpend && passSpend.ok && chosenPass && (
          <span className="text-slate-500">
            {chosenPass.kind === "time"
              ? t("form.passSpendTime", { len: lengthLabel(t, passSpend.units), per: weeks > 1 ? t("form.passPerWeekTime", { len: lengthLabel(t, passSpend.units * weeks) }) : "" })
              : t.plural("form.passSpend", passSpend.units, {
                  per: weeks > 1 ? t("form.passPerWeek", { total: passSpend.units * weeks }) : "",
                })}
          </span>
        )}
      </div>
      )}
      {weeks > 1 && (
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={skipConflicts}
            onChange={(e) => setSkipConflicts(e.target.checked)}
            className="accent-teal-600"
          />
          {t("form.skipTaken")}
        </label>
      )}
      {lastMinute > 0 && <p className="mt-2 text-xs font-medium text-amber-800">⏱ {t("lm.note", { n: lastMinute })}</p>}
      {email.trim() !== "" && (
        <label className="mt-2 flex items-start gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="mt-0.5 accent-teal-600" />
          {t("mkt.optIn", { venue: venueName })}
        </label>
      )}
      <div className="mt-3">
        <BookingTermsNotice venueId={court.venueId} sport={court.sport} />
      </div>
    </form>
  );
}

/**
 * The start and length of a booking, picked in the form: the court's starts
 * and lengths by default, or any minute and length for a manager booking
 * outside the rules. A long list of starts (a court taking bookings at any
 * minute) is typed rather than scrolled.
 */
function TimePicker({
  t,
  selection,
  starts,
  lengths,
  override,
  onChange,
}: {
  t: T;
  selection: Selection;
  starts: StartOption[];
  lengths: number[];
  override: boolean;
  onChange: (s: Selection) => void;
}) {
  const field = "mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none";
  const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  // Typed: "18:07", read as a minute of the day this booking's day (past midnight stays after it).
  const typed = (text: string) => {
    const m = parseClock(text);
    if (m === null) return null;
    return selection.start >= 1440 && m < 240 ? m + 1440 : m;
  };
  const freeStart = override || starts.length > 96;
  const freeLength = override || lengths.length > 48;
  return (
    <>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("board.start")}
        {freeStart ? (
          <input
            type="time"
            step={60}
            value={clock(selection.start)}
            onChange={(e) => {
              const m = typed(e.target.value);
              if (m === null) return;
              const option = starts.find((s) => s.minute === m);
              const takes = option ? lengths.filter((l) => l <= selection.length && startTakes(option, l)) : [];
              const length = override || !option ? selection.length : startTakes(option, selection.length) ? selection.length : (takes[takes.length - 1] ?? Math.min(selection.length, option.maxLength));
              onChange({ ...selection, start: m, length });
            }}
            className={field}
          />
        ) : (
          <select
            value={selection.start}
            onChange={(e) => {
              const m = Number(e.target.value);
              const option = starts.find((s) => s.minute === m);
              const fits = option ? lengths.filter((l) => startTakes(option, l)) : [];
              onChange({ ...selection, start: m, length: fits.includes(selection.length) ? selection.length : (fits[fits.length - 1] ?? selection.length) });
            }}
            className={field}
          >
            {starts.map((s) => (
              <option key={s.minute} value={s.minute}>
                {formatMinute(s.minute)}
              </option>
            ))}
          </select>
        )}
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("board.length")}
        {freeLength ? (
          <input
            type="number"
            min={1}
            max={1440}
            value={selection.length}
            onChange={(e) => {
              const l = Number(e.target.value);
              if (Number.isInteger(l) && l > 0) onChange({ ...selection, length: l });
            }}
            className={`${field} w-24`}
            aria-describedby="length-minutes"
          />
        ) : (
          <select value={selection.length} onChange={(e) => onChange({ ...selection, length: Number(e.target.value) })} className={field}>
            {lengths.map((l) => (
              <option key={l} value={l}>
                {lengthLabel(t, l)}
              </option>
            ))}
          </select>
        )}
        {freeLength && (
          <span id="length-minutes" className="mt-0.5 font-normal text-slate-400">
            {t("board.inMinutes")}
          </span>
        )}
      </label>
    </>
  );
}

function ConfirmationModal({
  t,
  confirmation,
  onClose,
}: {
  t: T;
  confirmation: Confirmation;
  onClose: () => void;
}) {
  const { booking, bookings, skipped, seriesCode, court, venue } = confirmation;
  // Several courts at the same time, booked as one: listed by court, each with its own code.
  const isGroup = bookings.length > 1 && seriesCode === null && !!booking.groupCode;
  const courtName = (id: number) => confirmation.courtNames?.[id] ?? court.name;
  const isSeries = (bookings.length > 1 || seriesCode !== null) && !isGroup;
  const seriesTotal = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
  const unpaid = bookings.filter((b) => b.paymentStatus === "unpaid");
  const unpaidTotal = unpaid.reduce((sum, b) => sum + b.totalPrice, 0);
  // Held until paid, at a venue that asks for payment online to hold it.
  const holdUntil = bookings.find((b) => b.holdUntil)?.holdUntil ?? null;
  const shareInfo = {
    siteName: t.site,
    code: seriesCode ?? booking.code,
    date: booking.date,
    startHour: booking.startHour,
    endHour: booking.endHour,
    courtName: court.name,
    venueName: venue.name,
    timeZone: venue.timeZone,
    totalPrice: isSeries || isGroup ? seriesTotal : booking.totalPrice,
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="text-center">
          <div className="text-4xl">{holdUntil ? "⏳" : "✅"}</div>
          <h2 className="mt-2 text-xl font-bold">
            {holdUntil
              ? t("hold.title")
              : isSeries
                ? t("done.seriesTitle", { n: bookings.length })
                : isGroup
                  ? t("done.groupTitle", { n: bookings.length })
                  : t("done.title")}
          </h2>
          {holdUntil ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              {t("hold.body", { time: localTimeOf(holdUntil, venue.timeZone) })}
            </p>
          ) : isGroup ? null : (
            <p className="mt-1 text-sm text-slate-600">
              {t("done.body", {
                what: isSeries ? t("done.theSeries") : t("done.theBooking"),
              })}
            </p>
          )}
          {!isGroup && (
            <div className="mt-4 rounded-xl bg-teal-50 py-4 text-3xl font-bold tracking-widest text-teal-700">
              {seriesCode ?? booking.code}
            </div>
          )}
        </div>
        <dl className="mt-5 space-y-1.5 text-sm">
          {[
            [t("done.venue"), `${venue.name} (${venue.area})`],
            [t("done.court"), isGroup ? bookings.map((b) => courtName(b.courtId)).join(", ") : court.name],
            ...(isSeries
              ? ([] as [string, string][])
              : ([[t("done.date"), booking.date]] as [string, string][])),
            [t("done.time"), `${formatMinute(booking.startMin)} – ${formatMinute(booking.endMin)}`],
            ...((booking.players ?? 1) > 1 ? ([[t("done.players"), String(booking.players)]] as [string, string][]) : ([] as [string, string][])),
            ...(confirmation.addons?.length
              ? ([
                  [
                    t("done.extras"),
                    confirmation.addons.map((a) => `${a.quantity} × ${a.name} (${money(a.unitPrice)})`).join(", "),
                  ],
                ] as [string, string][])
              : ([] as [string, string][])),
            ...(confirmation.discount
              ? ([[t("done.promoDiscount"), `− ${money(confirmation.discount)}`]] as [string, string][])
              : ([] as [string, string][])),
            [
              t("done.total"),
              (isSeries || isGroup ? seriesTotal : booking.totalPrice) === 0
                ? t("price.free")
                : holdUntil
                  ? t("hold.total", { amount: isSeries || isGroup ? seriesTotal : booking.totalPrice })
                  : t("done.totalValue", { amount: isSeries || isGroup ? seriesTotal : booking.totalPrice }),
            ],
            ...(isHire(court)
              ? ([
                  [t("done.deposit"), t("done.depositValue", { amount: court.deposit })],
                ] as [string, string][])
              : ([] as [string, string][])),
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-slate-500">{label}</dt>
              <dd className="text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        {confirmation.promoError && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("done.promoRejected", { reason: confirmation.promoError })}
          </p>
        )}
        {confirmation.account && (
          <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">{t("done.onAccount", { name: confirmation.account.name })}</p>
        )}
        {confirmation.concession && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            {t("done.concession", concessionWords(t, confirmation.concession))}
          </p>
        )}
        {confirmation.concessionError && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("done.concessionRejected", { reason: translateError(t, confirmation.concessionError) })}
          </p>
        )}
        {confirmation.addonError && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("done.addonRejected", { reason: translateError(t, confirmation.addonError) })}
          </p>
        )}
        {isGroup && (
          <div className="mt-4 rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm">
            <div className="font-semibold text-slate-700">{t("done.groupCodes")}</div>
            <ul className="mt-1 space-y-0.5">
              {bookings.map((b) => (
                <li key={b.id} className="flex justify-between gap-3">
                  <span>{courtName(b.courtId)}</span>
                  <span className="font-mono font-semibold text-teal-700">
                    {b.code} <span className="font-sans text-xs font-normal text-slate-500">· {b.totalPrice === 0 ? t("price.free") : money(b.totalPrice)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {isSeries && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="font-semibold text-slate-700">{t("done.sessions")}</div>
            <ul className="mt-1 space-y-0.5">
              {bookings.map((b) => (
                <li key={b.id} className="flex justify-between">
                  <span>📅 {b.date}</span>
                  <span className="font-mono text-xs text-slate-500">
                    {b.code} · {b.totalPrice === 0 ? t("price.free") : `${money(b.totalPrice)}`}
                  </span>
                </li>
              ))}
              {skipped.map((s) => (
                <li key={s.date} className="flex justify-between text-slate-400">
                  <span>📅 {s.date}</span>
                  <span className="text-xs">{t("done.skipped", { reason: s.reason })}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {confirmation.payOnline && unpaid.length > 0 && unpaidTotal > 0 && (
          <PayOnline codes={unpaid.map((b) => b.code)} phone={booking.phone} amount={unpaidTotal} held={holdUntil !== null} depositPercent={confirmation.depositPercent ?? null} />
        )}
        {confirmation.payOnline && !isSeries && !isGroup && holdUntil === null && booking.paymentStatus === "unpaid" && booking.totalPrice > 0 && (
          <SplitCost code={booking.code} phone={booking.phone} total={booking.totalPrice} venueName={confirmation.venue.name} date={booking.date} />
        )}
        <ChatLink t={t} number={confirmation.chatNumber} code={seriesCode ?? booking.code} />
        {!isSeries && booking.checkInToken && <CheckInQr token={booking.checkInToken} />}
        <div className="mt-5 grid grid-cols-3 gap-2 text-xs font-medium">
          <a
            href={whatsappShareUrl(shareInfo)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 py-2 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
          >
            📤 {t("done.share")}
          </a>
          <a
            href={googleCalendarUrl(shareInfo)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 py-2 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
          >
            📅 Google Cal
          </a>
          <button
            type="button"
            onClick={() => downloadIcs(shareInfo)}
            className="rounded-lg border border-slate-300 py-2 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
          >
            ⬇️ {t("done.icsFile")}
          </button>
        </div>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
        >
          {t("done.close")}
        </button>
      </div>
    </div>
  );
}

function SlotWaitlistModal({
  t,
  court,
  date,
  minute,
  length,
  onClose,
}: {
  t: T;
  court: Court;
  date: string;
  /** The time wanted: from this minute of the day, this long. */
  minute: number;
  length: number;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  // Who the place is for: the entry keeps them, and an offer is booked for them (lib/participant-bookings.ts).
  const [signedIn, setSignedIn] = useState(false);
  const people = useManagedPeople(signedIn);
  const [forIds, setForIds] = useState<number[]>([]);
  const [meToo, setMeToo] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!data.user) {
          const guest = rememberedGuest();
          if (guest) {
            setName((v) => v || guest.name);
            setPhone((v) => v || guest.phone);
            setEmail((v) => v || guest.email);
          }
          return;
        }
        setSignedIn(true);
        setName((v) => v || data.user.name);
        setPhone((v) => v || data.user.phone);
        setEmail((v) => v || data.user.email);
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtId: court.id,
          date,
          start: minute,
          end: minute + length,
          name,
          phone,
          email,
          ...whoBody(forIds, meToo),
        }),
      });
      const data = await res.json();
      if (!res.ok && typeof data?.code === "string" && (data.code.startsWith("GUARD_") || data.code.startsWith("PBK_"))) throw new Error(explainGuard(t, data));
      if (!res.ok) throw new Error(translateError(t, data) || t("queue.failed"));
      setPosition(data.position);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("queue.failed"));
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        {position !== null ? (
          <div className="text-center">
            <div className="text-4xl">⏳</div>
            <h2 className="mt-2 text-xl font-bold">{t("queue.onTitle")}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {t("queue.onBody", {
                position,
                court: court.name,
                time: formatMinute(minute),
              })}
            </p>
            <p className="mt-3 text-xs text-slate-500">
              {t("queue.onNote")}
            </p>
            <button
              onClick={onClose}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
            >
              {t("done.close")}
            </button>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-bold">{court.name}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {date} · {formatMinute(minute)} – {formatMinute(minute + length)}
            </p>
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {t("queue.taken")}
            </p>
            <form onSubmit={submit} className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                {t("form.name")}
                <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                {t("form.phone")}
                <input required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t("auth.phonePlaceholder")} className={inputClass} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                {t("form.emailOptional")}
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
              </label>
              <WhoTakesPart
                t={t}
                people={people}
                ids={forIds}
                meToo={meToo}
                onChange={(ids, me) => {
                  setForIds(ids);
                  setMeToo(me);
                }}
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-lg border border-slate-300 py-2 text-sm font-medium text-slate-600 hover:border-slate-400"
                >
                  {t("queue.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 rounded-lg bg-teal-600 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {busy ? t("queue.joining") : t("queue.join")}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
