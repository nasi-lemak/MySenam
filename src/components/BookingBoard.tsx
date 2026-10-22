"use client";

import { accountDetour } from "@/lib/phone-detour";
import BookingTermsNotice from "@/components/BookingTermsNotice";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Booking,
  busyness,
  Court,
  CourtAvailability,
  isHire,
  isShared,
  MAX_HOURS_PER_BOOKING,
  MAX_RECUR_WEEKS,
  MAX_GROUP_COURTS,
  DEFAULT_MAX_PLAYERS,
  bookingLengths,
  Sport,
  SPORT_ICONS,
  Pass,
  VenueClosure,
} from "@/lib/types";
import { consecutive, formatHour, isPastSlot } from "@/lib/time";
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
import { money, intlTag, region, plainAmount, localTimeOf, shortDate } from "@/lib/region";

interface Props {
  venueId: number;
  /** For the box asking whether to hear from it. */
  venueName?: string;
  sports: Sport[];
  dates: string[];
  /** Slot to pre-select, e.g. when arriving from a search result. */
  initial?: { sport?: Sport; date?: string; courtId?: number; hours?: number[] };
}

/** A selection on the "Any court" row, rather than on a named court. */
const ANY_COURT = -1;

interface Selection {
  courtId: number;
  hours: number[];
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
  concession?: { name: string; proof: string } | null;
  concessionError?: { error: string; code?: string; vars?: Record<string, string | number> } | null;
}

/** A concession price the venue offers (lib/concessions.ts). */
interface Concession {
  id: number;
  name: string;
  percent: number;
  proof: string;
  sport: Sport | null;
  offPeakOnly: boolean;
}

/** Cell colour by how full a shared facility is — the crowd signal. */
const BUSY_STYLES: Record<string, string> = {
  quiet: "bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
  filling: "bg-amber-50 text-amber-700 hover:bg-amber-100",
  busy: "bg-orange-100 text-orange-800 hover:bg-orange-200",
  full: "bg-slate-100 text-slate-300",
};

/**
 * A taken slot can be queued for; a blocked, class-reserved or past one
 * cannot, because no cancellation will ever free it. Past by the venue's clock.
 */
/**
 * The cheapest court free for every one of these hours, and what it costs;
 * null when no single court is. The server picks the same way.
 */
function cheapestWholeCourt(
  availability: CourtAvailability[] | null | undefined,
  hours: number[]
): { total: number; lastMinute: number } | null {
  let best: { total: number; lastMinute: number } | null = null;
  for (const a of availability ?? []) {
    const slots = hours.map((h) => a.slots.find((s) => s.hour === h));
    if (slots.some((s) => !s || !s.available)) continue;
    const total = slots.reduce((sum, s) => sum + s!.rate, 0);
    if (!best || total < best.total)
      best = { total, lastMinute: Math.max(0, ...slots.map((s) => s!.lastMinute ?? 0)) };
  }
  return best;
}

function canQueue(slot: CourtAvailability["slots"][number], date: string, zone: string): boolean {
  if (slot.available || slot.blocked || slot.className) return false;
  return !isPastSlot(date, slot.hour, zone);
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
    initial?.courtId && initial.hours?.length
      ? { courtId: initial.courtId, hours: initial.hours }
      : null
  );
  const [availability, setAvailability] = useState<CourtAvailability[] | null>(null);
  const [closure, setClosure] = useState<VenueClosure | null>(null);
  const [memberRates, setMemberRates] = useState(false);
  // The venue's clock, which the slots and "already passed" go by.
  const [zone, setZone] = useState(region().timeZone);
  // The most weeks one weekly booking may run at this venue.
  const [maxWeeks, setMaxWeeks] = useState(MAX_RECUR_WEEKS);
  // Concession prices offered here.
  const [concessions, setConcessions] = useState<Concession[]>([]);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [waitlistSlot, setWaitlistSlot] = useState<{
    court: Court;
    hour: number;
  } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Open the grid on the first hour there is something to book (or on the
  // hour already chosen, arriving from search), not on the venue's opening
  // hour. On a phone only four hours fit; in the evening those four are the
  // morning's, all past and greyed out, and the free ones are off to the right
  // where a first-time visitor will not think to look.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !availability || grid.scrollWidth <= grid.clientWidth) return;
    const hours = availability[0]?.slots.map((s) => s.hour) ?? [];
    const target =
      selection?.hours[0] ??
      hours.find((h) => availability.some((a) => a.slots.find((s) => s.hour === h)?.available));
    if (target === undefined) return;
    const column = grid.querySelector<HTMLElement>(`th[data-hour="${target}"]`);
    const courtNames = grid.querySelector<HTMLElement>("th");
    if (column && courtNames) grid.scrollLeft = Math.max(column.offsetLeft - courtNames.offsetWidth, 0);
    // Only when a new day or sport is loaded, not on every tap of a slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability]);

  const loadAvailability = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/availability?venueId=${venueId}&date=${date}&sport=${sport}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("board.loadFailed"));
      const slots: CourtAvailability[] = data.availability;
      setAvailability(slots);
      setClosure(data.closure ?? null);
      setMemberRates(data.memberRates === true);
      if (typeof data.timeZone === "string") setZone(data.timeZone);
      if (Number.isInteger(data.seriesWeeks)) setMaxWeeks(data.seriesWeeks);
      setConcessions(Array.isArray(data.concessions) ? data.concessions : []);

      const pending = pendingInitial.current;
      if (pending) {
        pendingInitial.current = null;
        const courtAvail = slots.find((a) => a.court.id === pending.courtId);
        const stillFree = pending.hours.every(
          (h) => courtAvail?.slots.find((s) => s.hour === h)?.available
        );
        if (stillFree) setSelection({ courtId: pending.courtId, hours: pending.hours });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("board.loadFailed"));
      setAvailability(null);
      setClosure(null);
      setMemberRates(false);
    } finally {
      setLoading(false);
    }
  }, [venueId, date, sport, t]);

  useEffect(() => {
    setSelection(null);
    loadAvailability();
  }, [loadAvailability]);

  const hasShared = useMemo(
    () => (availability ?? []).some((a) => a.court.capacity > 1),
    [availability]
  );

  /** How long one slot is, in hours: 1, or 0.5 where the venue sells half hours. */
  const step = useMemo(() => {
    const slots = availability?.[0]?.slots;
    return slots && slots.length > 1 ? slots[1].hour - slots[0].hour : 1;
  }, [availability]);

  /**
   * A synthetic row standing for "whichever court, pick the cheapest". Worth
   * offering only when there is more than one court to choose between.
   */
  const anyRow = useMemo(() => {
    if (!availability || availability.length < 2) return null;
    const slots = availability[0].slots.map((_, i) => {
      const hour = availability[0].slots[i].hour;
      const free = availability
        .map((a) => a.slots[i])
        .filter((s) => s && s.hour === hour && s.available);
      return {
        hour,
        available: free.length > 0,
        rate: free.length > 0 ? Math.min(...free.map((s) => s.rate)) : 0,
        courts: free.length,
      };
    });
    return slots;
  }, [availability]);

  const selectedCourt = useMemo(() => {
    if (selection?.courtId === ANY_COURT) {
      // A stand-in so the form below can stay unchanged; the submit path
      // sends venue + sport instead of this id.
      const first = availability?.[0]?.court;
      if (!first) return null;
      return {
        id: ANY_COURT,
        venueId: first.venueId,
        name: t("board.anyCourt"),
        sport: first.sport,
        offPeakRate: 0,
        peakRate: 0,
        capacity: 1,
      } as Court;
    }
    return availability?.find((a) => a.court.id === selection?.courtId)?.court ?? null;
  }, [availability, selection, t]);

  /**
   * For "Any court", the court the server will give: the cheapest one free for
   * every hour picked. The cheapest rate per hour across all courts would add
   * up to a price no single court charges.
   */
  const anyChoice = useMemo(
    () => (selection?.courtId === ANY_COURT ? cheapestWholeCourt(availability, selection.hours) : null),
    [selection, availability]
  );

  const totalPrice = useMemo(() => {
    if (!selection || !availability) return 0;
    if (selection.courtId === ANY_COURT) return anyChoice?.total ?? 0;
    const courtAvail = availability.find((a) => a.court.id === selection.courtId);
    if (!courtAvail) return 0;
    return selection.hours.reduce(
      (sum, h) => sum + (courtAvail.slots.find((s) => s.hour === h)?.rate ?? 0),
      0
    );
  }, [selection, availability, anyChoice]);

  /**
   * Other courts free for every hour picked, to book with it as one: whole
   * courts that take a booking that long, with what those hours cost there.
   */
  const alsoFree = useMemo(() => {
    if (!selection || !availability || selection.courtId === ANY_COURT) return [];
    const length = selection.hours.length * step;
    return availability
      .filter((a) => a.court.id !== selection.courtId && a.court.capacity === 1)
      .filter((a) => {
        const l = bookingLengths(a.court, step);
        return length >= l.min && length <= l.max;
      })
      .filter((a) => selection.hours.every((h) => a.slots.find((s) => s.hour === h)?.available))
      .map((a) => ({
        court: a.court,
        price: selection.hours.reduce((sum, h) => sum + (a.slots.find((s) => s.hour === h)?.rate ?? 0), 0),
      }));
  }, [selection, availability, step]);

  /** The last-minute discount on the hours picked, if any: the form says what it is. */
  const lastMinute = useMemo(() => {
    if (!selection || !availability) return 0;
    if (selection.courtId === ANY_COURT) return anyChoice?.lastMinute ?? 0;
    const slots = availability.find((a) => a.court.id === selection.courtId)?.slots ?? [];
    return Math.max(0, ...selection.hours.map((h) => slots.find((s) => s.hour === h)?.lastMinute ?? 0));
  }, [selection, availability, anyChoice]);

  function toggleSlot(courtId: number, hour: number) {
    setError(null);
    setSelection((prev) => {
      if (!prev || prev.courtId !== courtId) return { courtId, hours: [hour] };
      const hours = prev.hours.includes(hour)
        ? prev.hours.filter((h) => h !== hour)
        : [...prev.hours, hour].sort((a, b) => a - b);
      if (hours.length === 0) return null;
      // Keep the selection contiguous: if toggling breaks contiguity, restart from this slot.
      if (!consecutive(hours, step)) return { courtId, hours: [hour] };
      // As long as this court may be booked for: its own limit, or four hours.
      const court = availability?.find((a) => a.court.id === courtId)?.court;
      const longest = court ? bookingLengths(court, step).max : MAX_HOURS_PER_BOOKING;
      if (hours.length * step > longest) return prev;
      // "Any court" still means one court for the whole booking.
      if (courtId === ANY_COURT && !cheapestWholeCourt(availability, hours)) return { courtId, hours: [hour] };
      return { courtId, hours };
    });
  }

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
            {SPORT_ICONS[s]} {sportLabel(t, s)}
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
                  <th key={slot.hour} data-hour={slot.hour} className="px-1 py-2 text-center font-medium text-slate-500">
                    {formatHour(slot.hour).replace(":00 ", "").replace(" ", "")}
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
                      selection?.courtId === ANY_COURT && selection.hours.includes(slot.hour);
                    return (
                      <td key={slot.hour} className="p-1 text-center">
                        <button
                          disabled={!slot.available}
                          onClick={() => toggleSlot(ANY_COURT, slot.hour)}
                          title={
                            slot.available
                              ? t.plural("board.anyFree", slot.courts, {
                                  time: formatHour(slot.hour),
                                  rate: slot.rate,
                                })
                              : t("board.anyNone")
                          }
                          className={`h-9 w-11 rounded-md text-xs font-medium transition ${
                            !slot.available
                              ? "cursor-not-allowed bg-slate-100 text-slate-300"
                              : isSelected
                                ? "bg-teal-600 text-white shadow"
                                : "bg-teal-100 text-teal-800 hover:bg-teal-200"
                          }`}
                        >
                          {slot.available ? (slot.rate === 0 ? t("price.free") : plainAmount(slot.rate)) : "—"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              )}
              {availability.map(({ court, slots }) => (
                <tr key={court.id} className="border-b border-slate-100 last:border-0">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-2 font-medium">
                    {court.name}
                    <div className="text-xs font-normal text-slate-400">
                      {court.offPeakRate === 0 && court.peakRate === 0
                        ? t("price.free")
                        : t(court.perPlayer ? "board.rateRangePlayer" : "board.rateRange", { from: court.offPeakRate, to: plainAmount(court.peakRate) })}
                      {isShared(court) && ` · ${t("board.places", { n: court.capacity })}`}
                      {isHire(court) && ` · ${t("board.depositLine", { amount: court.deposit })}`}
                    </div>
                  </td>
                  {slots.map((slot) => {
                    const isSelected =
                      selection?.courtId === court.id && selection.hours.includes(slot.hour);
                    const shared = isShared(court);
                    const left = slot.capacity - slot.booked;
                    const level = busyness(slot.booked, slot.capacity);
                    return (
                      <td key={slot.hour} className="p-1 text-center">
                        <button
                          disabled={!slot.available && !canQueue(slot, date, zone)}
                          onClick={() =>
                            slot.available
                              ? toggleSlot(court.id, slot.hour)
                              : setWaitlistSlot({ court, hour: slot.hour })
                          }
                          title={
                            !slot.available
                              ? canQueue(slot, date, zone)
                                ? t("board.queueHint")
                                : slot.className
                                  ? t("board.reservedFor", { name: slot.className })
                                  : t("board.unavailable")
                              : shared
                                ? t("board.sharedSlot", {
                                    time: formatHour(slot.hour),
                                    rate: slot.rate,
                                    left,
                                    capacity: slot.capacity,
                                    level: t(`busy.${level}` as Phrase),
                                  })
                                : t("board.plainSlot", {
                                    time: formatHour(slot.hour),
                                    rate: slot.rate,
                                  })
                          }
                          className={`h-9 w-11 rounded-md text-xs font-medium transition ${
                            !slot.available
                              ? canQueue(slot, date, zone)
                                ? "cursor-pointer bg-slate-100 text-slate-400 hover:bg-amber-100 hover:text-amber-700"
                                : "cursor-not-allowed bg-slate-100 text-slate-300"
                              : isSelected
                                ? "bg-teal-600 text-white shadow"
                                : shared
                                  ? BUSY_STYLES[level]
                                  : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          }`}
                        >
                          {!slot.available ? (canQueue(slot, date, zone) ? "+" : "—") : shared ? left : slot.rate === 0 ? t("price.free") : plainAmount(slot.rate)}
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
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            <span>
              <span className="mr-1 inline-block h-3 w-3 rounded bg-emerald-100 align-middle" />
              {step < 1 ? t("board.legendFreeHalf") : t("board.legendFree")}
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
            <span className="ml-auto">
              {t("board.maxHours", {
                n: Math.max(MAX_HOURS_PER_BOOKING, ...(availability ?? []).map((a) => bookingLengths(a.court, step).max)),
              })}
            </span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          {t("board.noCourts", { sport: sportLabel(t, sport).toLowerCase() })}
        </div>
      )}

      {/* Booking bar */}
      {selection && selectedCourt && (
        <BookingForm
          t={t}
          venueName={venueName}
          court={selectedCourt}
          date={date}
          hours={selection.hours}
          step={step}
          maxWeeks={maxWeeks}
          alsoFree={alsoFree}
          concessions={concessions.filter(
            (c) =>
              (c.sport === null || c.sport === selectedCourt.sport) &&
              !(c.offPeakOnly && selection.hours.some((h) => availability?.find((a) => a.court.id === selectedCourt.id)?.slots.find((sl) => sl.hour === h)?.peak))
          )}
          totalPrice={totalPrice}
          lastMinute={lastMinute}
          onBooked={(c) => {
            setConfirmation(c);
            setSelection(null);
            loadAvailability();
          }}
          onError={(msg) => {
            setError(msg);
            loadAvailability();
          }}
        />
      )}

      {waitlistSlot && (
        <SlotWaitlistModal
          t={t}
          court={waitlistSlot.court}
          date={date}
          hour={waitlistSlot.hour}
          step={step}
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
  hours,
  step,
  maxWeeks = MAX_RECUR_WEEKS,
  alsoFree = [],
  concessions = [],
  totalPrice: courtPrice,
  lastMinute = 0,
  onBooked,
  onError,
}: {
  t: T;
  venueName: string;
  court: Court;
  date: string;
  hours: number[];
  /** One slot's length in hours. */
  step: number;
  /** The most weeks one weekly booking may run here. */
  maxWeeks?: number;
  /** Other courts free then, to book with this one as one, and what those hours cost on each. */
  alsoFree?: { court: Court; price: number }[];
  /** Concession prices that apply to these hours on this court. */
  concessions?: Concession[];
  totalPrice: number;
  /** Percent off the hours picked, for booking them now. */
  lastMinute?: number;
  onBooked: (c: Confirmation) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // News from this venue: asked, never ticked for them (lib/marketing.ts).
  const [marketing, setMarketing] = useState(false);
  const [weeks, setWeeks] = useState(1);
  // Other courts booked with this one, at the same time.
  const [more, setMore] = useState<number[]>([]);
  const hoursKey = hours.join(",");
  useEffect(() => setMore([]), [court.id, hoursKey, date]);
  const moreChosen = alsoFree.filter((a) => more.includes(a.court.id));
  // A concession price: that share off the court time, shown at the counter.
  const [concessionId, setConcessionId] = useState<number | null>(null);
  const concession = concessions.find((c) => c.id === concessionId) ?? null;
  // On a court priced per player, how many play: the price is for each of them.
  const [players, setPlayers] = useState(2);
  const mostPlayers = court.maxPlayers ?? DEFAULT_MAX_PLAYERS;
  const perHead = court.perPlayer ? players : 1;
  const courtsTotal = courtPrice * perHead + moreChosen.reduce((sum, a) => sum + a.price * (a.court.perPlayer ? players : 1), 0);
  const totalPrice = Math.round(courtsTotal * (1 - (concession?.percent ?? 0) / 100) * 100) / 100;
  // This court's own shortest and longest booking, when it has them.
  const lengths = bookingLengths(court, step);
  const ownLengths = court.id !== ANY_COURT && (court.minHours != null || court.maxHours != null);
  const tooShort = court.id !== ANY_COURT && hours.length * step < lengths.min;
  const [balance, setBalance] = useState<number | null>(null);
  const [payFromWallet, setPayFromWallet] = useState(false);
  const [passCode, setPassCode] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [myPasses, setMyPasses] = useState<Pass[]>([]);
  const [skipConflicts, setSkipConflicts] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [remembered, setRemembered] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked>({});
  const [offered, setOffered] = useState<OfferedAddon[]>([]);
  const extras = pickedTotal(offered, picked);
  const withExtras = Math.round((totalPrice + extras) * 100) / 100;
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // ANY_COURT means "you pick": send the venue and sport instead.
          ...(court.id === ANY_COURT
            ? { venueId: court.venueId, sport: court.sport }
            : { courtId: court.id }),
          date,
          hours,
          name,
          phone,
          email,
          weeks,
          skipConflicts,
          payFromWallet: (hasExtras || passCode.trim() === "") && payFromWallet,
          payWithPass: (!hasExtras && passCode.trim()) || undefined,
          promoCode: promoCode.trim() || undefined,
          addons: pickedList(picked),
          marketing: email.trim() !== "" && marketing,
          ...(moreChosen.length > 0 ? { moreCourts: moreChosen.map((a) => a.court.id) } : {}),
          ...(concession ? { concessionId: concession.id } : {}),
          ...(court.perPlayer ? { players } : {}),
        }),
      });
      const data = await res.json();
      // Back to this very selection once the phone is sorted out.
      if (
        !res.ok &&
        court.id !== ANY_COURT &&
        accountDetour(data, `/venue/${court.venueId}?date=${date}&sport=${court.sport}&court=${court.id}&hour=${hours[0]}&duration=${hours.length * step}`)
      )
        return;
      if (!res.ok && accountDetour(data)) return;
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
          <div className="font-semibold text-teal-700">{court.name}</div>
          <div className="text-sm text-slate-600">
            {date} · {formatHour(hours[0])} – {formatHour(hours[hours.length - 1] + step)} ·{" "}
            <span className="font-semibold text-slate-900">{withExtras === 0 ? t("price.free") : `${money(withExtras)}`}</span>
          </div>
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
          disabled={submitting || tooShort}
          className="rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white shadow transition hover:bg-teal-700 disabled:opacity-50"
        >
          {submitting
            ? t("form.booking")
            : weeks > 1
              ? t("form.bookWeeks", { weeks, amount: withExtras })
              : t("form.book", { amount: withExtras })}
        </button>
      </div>
      {court.perPlayer && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <label className="flex items-center gap-2">
            {t("form.players")}
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
          </label>
          <span className="text-slate-500">{t("form.playersNote", { n: players, price: money(courtPrice) })}</span>
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
                  {t("form.concessionOption", { name: c.name, pct: c.percent })}
                </option>
              ))}
            </select>
          </label>
          {concession && <p className="mt-1 font-medium text-amber-800">{t("form.concessionProof", { proof: concession.proof })}</p>}
        </div>
      )}
      {alsoFree.length > 0 && weeks === 1 && !hasExtras && (
        <details className="mt-2 text-xs text-slate-600" open={more.length > 0}>
          <summary className="cursor-pointer font-medium text-teal-700">{t("form.alsoBook")}</summary>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {alsoFree.map((a) => (
              <label key={a.court.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-teal-600"
                  checked={more.includes(a.court.id)}
                  // The most courts booked together, this one included.
                  disabled={!more.includes(a.court.id) && more.length + 1 >= MAX_GROUP_COURTS}
                  onChange={(e) => setMore(e.target.checked ? [...more, a.court.id] : more.filter((id) => id !== a.court.id))}
                />
                {a.court.name} · {a.price === 0 ? t("price.free") : money(a.price)}
              </label>
            ))}
          </div>
          <p className="mt-1 text-slate-500">{t("form.alsoBookNote")}</p>
        </details>
      )}
      {(tooShort || ownLengths) && (
        <p className={`mt-2 text-xs ${tooShort ? "font-medium text-amber-700" : "text-slate-500"}`}>
          {t("board.lengths", { min: lengths.min, max: lengths.max, court: court.name })}
        </p>
      )}
      {more.length === 0 && (
      <AddonPicker
        t={t}
        query={`${court.id === ANY_COURT ? `venueId=${court.venueId}&sport=${court.sport}` : `courtId=${court.id}`}&date=${date}&hours=${hours.join(",")}`}
        picked={picked}
        onChange={setPicked}
        onList={setOffered}
      />
      )}
      {balance !== null && balance > 0 && (hasExtras || passCode.trim() === "") && (
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

      {/* A pass covers one entry per booked hour, so it settles the whole slot —
          court time only, so not a booking with extras. */}
      {hasExtras ? (
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
                {t("form.passOption", { name: p.name, n: p.remaining })}
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
        {passCode.trim() !== "" && (
          <span className="text-slate-500">
            {t.plural("form.passSpend", Math.ceil(hours.length * step), {
              per:
                weeks > 1
                  ? t("form.passPerWeek", { total: Math.ceil(hours.length * step) * weeks })
                  : "",
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
        <BookingTermsNotice venueId={court.venueId} />
      </div>
    </form>
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
            [t("done.time"), `${formatHour(booking.startHour)} – ${formatHour(booking.endHour)}`],
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
        {confirmation.concession && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            {t("done.concession", { name: confirmation.concession.name, proof: confirmation.concession.proof })}
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
  hour,
  step,
  onClose,
}: {
  t: T;
  court: Court;
  date: string;
  hour: number;
  step: number;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<number | null>(null);

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
          startHour: hour,
          endHour: hour + step,
          name,
          phone,
          email,
        }),
      });
      const data = await res.json();
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
                time: formatHour(hour),
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
              {date} · {formatHour(hour)} – {formatHour(hour + step)}
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
