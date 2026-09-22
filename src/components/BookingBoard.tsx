"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Booking,
  BUSYNESS_LABELS,
  busyness,
  Court,
  CourtAvailability,
  isShared,
  MAX_HOURS_PER_BOOKING,
  MAX_RECUR_WEEKS,
  Sport,
  SPORT_ICONS,
  SPORT_LABELS,
  VenueClosure,
} from "@/lib/types";
import { formatHour } from "@/lib/time";
import { downloadIcs, googleCalendarUrl, whatsappShareUrl } from "@/lib/booking-links";
import CheckInQr from "@/components/CheckInQr";

interface Props {
  venueId: number;
  sports: Sport[];
  dates: string[];
  /** Slot to pre-select, e.g. when arriving from a search result. */
  initial?: { sport?: Sport; date?: string; courtId?: number; hours?: number[] };
}

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
  venue: { name: string; area: string };
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
 * cannot, because no cancellation will ever free it.
 */
function canQueue(slot: CourtAvailability["slots"][number], date: string): boolean {
  if (slot.available || slot.blocked || slot.className) return false;
  return !isPastSlotClient(date, slot.hour);
}

/** Past-slot check in Malaysia time, for the browser. */
function isPastSlotClient(date: string, hour: number): boolean {
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(now);
  if (date < today) return true;
  if (date > today) return false;
  const currentHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kuala_Lumpur",
      hour: "2-digit",
      hour12: false,
    }).format(now)
  );
  return hour <= currentHour % 24;
}

function formatDateLabel(date: string): { day: string; num: string } {
  const d = new Date(`${date}T00:00:00Z`);
  return {
    day: d.toLocaleDateString("en-MY", { weekday: "short", timeZone: "UTC" }),
    num: d.toLocaleDateString("en-MY", { day: "numeric", month: "short", timeZone: "UTC" }),
  };
}

export default function BookingBoard({ venueId, sports, dates, initial }: Props) {
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
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [waitlistSlot, setWaitlistSlot] = useState<{
    court: Court;
    hour: number;
  } | null>(null);

  const loadAvailability = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/availability?venueId=${venueId}&date=${date}&sport=${sport}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load availability");
      const slots: CourtAvailability[] = data.availability;
      setAvailability(slots);
      setClosure(data.closure ?? null);

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
      setError(e instanceof Error ? e.message : "Failed to load availability");
      setAvailability(null);
      setClosure(null);
    } finally {
      setLoading(false);
    }
  }, [venueId, date, sport]);

  useEffect(() => {
    setSelection(null);
    loadAvailability();
  }, [loadAvailability]);

  const hasShared = useMemo(
    () => (availability ?? []).some((a) => a.court.capacity > 1),
    [availability]
  );

  const selectedCourt = useMemo(
    () => availability?.find((a) => a.court.id === selection?.courtId)?.court ?? null,
    [availability, selection]
  );

  const totalPrice = useMemo(() => {
    if (!selection || !availability) return 0;
    const courtAvail = availability.find((a) => a.court.id === selection.courtId);
    if (!courtAvail) return 0;
    return selection.hours.reduce(
      (sum, h) => sum + (courtAvail.slots.find((s) => s.hour === h)?.rate ?? 0),
      0
    );
  }, [selection, availability]);

  function toggleSlot(courtId: number, hour: number) {
    setError(null);
    setSelection((prev) => {
      if (!prev || prev.courtId !== courtId) return { courtId, hours: [hour] };
      const hours = prev.hours.includes(hour)
        ? prev.hours.filter((h) => h !== hour)
        : [...prev.hours, hour].sort((a, b) => a - b);
      if (hours.length === 0) return null;
      // Keep the selection contiguous: if toggling breaks contiguity, restart from this hour.
      for (let i = 1; i < hours.length; i++) {
        if (hours[i] !== hours[i - 1] + 1) return { courtId, hours: [hour] };
      }
      if (hours.length > MAX_HOURS_PER_BOOKING) return prev;
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
            {SPORT_ICONS[s]} {SPORT_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Date strip */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {dates.map((d) => {
          const { day, num } = formatDateLabel(d);
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
          <strong>Closed on {closure.date}.</strong> Pick another date.
          {closure.reason && <div className="mt-0.5 text-amber-700">{closure.reason}</div>}
        </div>
      )}

      {/* Availability grid */}
      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          Loading availability…
        </div>
      ) : availability && availability.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-semibold">Court</th>
                {availability[0].slots.map((slot) => (
                  <th key={slot.hour} className="px-1 py-2 text-center font-medium text-slate-500">
                    {formatHour(slot.hour).replace(":00 ", "")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {availability.map(({ court, slots }) => (
                <tr key={court.id} className="border-b border-slate-100 last:border-0">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-2 font-medium">
                    {court.name}
                    <div className="text-xs font-normal text-slate-400">
                      RM{court.offPeakRate}–{court.peakRate}/hr
                      {isShared(court) && ` · ${court.capacity} places`}
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
                          disabled={!slot.available && !canQueue(slot, date)}
                          onClick={() =>
                            slot.available
                              ? toggleSlot(court.id, slot.hour)
                              : setWaitlistSlot({ court, hour: slot.hour })
                          }
                          title={
                            !slot.available
                              ? canQueue(slot, date)
                                ? "Taken — click to join the waitlist"
                                : slot.className
                                  ? `Reserved for ${slot.className}`
                                  : "Unavailable"
                              : shared
                                ? `${formatHour(slot.hour)} · RM${slot.rate} · ${left} of ${slot.capacity} places left (${BUSYNESS_LABELS[level]})`
                                : `${formatHour(slot.hour)} · RM${slot.rate}`
                          }
                          className={`h-9 w-11 rounded-md text-xs font-medium transition ${
                            !slot.available
                              ? canQueue(slot, date)
                                ? "cursor-pointer bg-slate-100 text-slate-400 hover:bg-amber-100 hover:text-amber-700"
                                : "cursor-not-allowed bg-slate-100 text-slate-300"
                              : isSelected
                                ? "bg-teal-600 text-white shadow"
                                : shared
                                  ? BUSY_STYLES[level]
                                  : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          }`}
                        >
                          {!slot.available ? (canQueue(slot, date) ? "+" : "—") : shared ? left : slot.rate}
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
              Available (number = RM/hr)
            </span>
            {hasShared && (
              <span>
                <span className="mr-1 inline-block h-3 w-3 rounded bg-amber-100 align-middle" />
                Shared facility (number = places left)
              </span>
            )}
            <span>
              <span className="mr-1 inline-block h-3 w-3 rounded bg-teal-600 align-middle" />
              Selected
            </span>
            <span>
              <span className="mr-1 inline-block h-3 w-3 rounded bg-slate-100 align-middle" />
              Booked / past
            </span>
            <span className="ml-auto">Max {MAX_HOURS_PER_BOOKING} consecutive hours per booking</span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          No {SPORT_LABELS[sport].toLowerCase()} courts at this venue.
        </div>
      )}

      {/* Booking bar */}
      {selection && selectedCourt && (
        <BookingForm
          court={selectedCourt}
          date={date}
          hours={selection.hours}
          totalPrice={totalPrice}
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
          court={waitlistSlot.court}
          date={date}
          hour={waitlistSlot.hour}
          onClose={() => setWaitlistSlot(null)}
        />
      )}

      {confirmation && (
        <ConfirmationModal confirmation={confirmation} onClose={() => setConfirmation(null)} />
      )}
    </div>
  );
}

function BookingForm({
  court,
  date,
  hours,
  totalPrice,
  onBooked,
  onError,
}: {
  court: Court;
  date: string;
  hours: number[];
  totalPrice: number;
  onBooked: (c: Confirmation) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [weeks, setWeeks] = useState(1);
  const [balance, setBalance] = useState<number | null>(null);
  const [payFromWallet, setPayFromWallet] = useState(false);
  const [skipConflicts, setSkipConflicts] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Prefill contact details for signed-in users.
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!data.user) return;
        setName((v) => v || data.user.name);
        setPhone((v) => v || data.user.phone);
        setEmail((v) => v || data.user.email);
        return fetch("/api/my/wallet", { cache: "no-store" });
      })
      .then((res) => (res && res.ok ? res.json() : null))
      .then((wallet) => {
        if (wallet) setBalance(wallet.balance);
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtId: court.id,
          date,
          hours,
          name,
          phone,
          email,
          weeks,
          skipConflicts,
          payFromWallet,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Booking failed");
      onBooked(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Booking failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="sticky bottom-4 rounded-xl border border-teal-200 bg-white p-4 shadow-lg"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <div className="font-semibold text-teal-700">{court.name}</div>
          <div className="text-sm text-slate-600">
            {date} · {formatHour(hours[0])} – {formatHour(hours[hours.length - 1] + 1)} ·{" "}
            <span className="font-semibold text-slate-900">RM{totalPrice}</span>
          </div>
        </div>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Name
          <input
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ali bin Abu"
            className="mt-1 w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Phone
          <input
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="012-345 6789"
            className="mt-1 w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Email (optional)
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mt-1 w-44 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Repeat
          <select
            value={weeks}
            onChange={(e) => setWeeks(Number(e.target.value))}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          >
            <option value={1}>Just once</option>
            {Array.from({ length: MAX_RECUR_WEEKS - 1 }, (_, i) => i + 2).map((w) => (
              <option key={w} value={w}>
                Weekly × {w}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white shadow transition hover:bg-teal-700 disabled:opacity-50"
        >
          {submitting
            ? "Booking…"
            : weeks > 1
              ? `Book ${weeks} weeks · RM${totalPrice}/wk`
              : `Book · RM${totalPrice}`}
        </button>
      </div>
      {balance !== null && balance > 0 && (
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={payFromWallet}
            onChange={(e) => setPayFromWallet(e.target.checked)}
            className="accent-teal-600"
          />
          Pay from my credit balance (RM{balance} available)
        </label>
      )}
      {weeks > 1 && (
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={skipConflicts}
            onChange={(e) => setSkipConflicts(e.target.checked)}
            className="accent-teal-600"
          />
          Skip weeks that are already taken (otherwise the whole series is rejected on any clash)
        </label>
      )}
    </form>
  );
}

function ConfirmationModal({
  confirmation,
  onClose,
}: {
  confirmation: Confirmation;
  onClose: () => void;
}) {
  const { booking, bookings, skipped, seriesCode, court, venue } = confirmation;
  const isSeries = bookings.length > 1 || seriesCode !== null;
  const seriesTotal = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
  const shareInfo = {
    code: seriesCode ?? booking.code,
    date: booking.date,
    startHour: booking.startHour,
    endHour: booking.endHour,
    courtName: court.name,
    venueName: venue.name,
    totalPrice: isSeries ? seriesTotal : booking.totalPrice,
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="text-center">
          <div className="text-4xl">✅</div>
          <h2 className="mt-2 text-xl font-bold">
            {isSeries ? `${bookings.length} weekly sessions booked!` : "Booking confirmed!"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Show this code at the counter. Save it — you&apos;ll need it (with your phone number)
            to view or cancel {isSeries ? "the series" : "the booking"}.
          </p>
          <div className="mt-4 rounded-xl bg-teal-50 py-4 text-3xl font-bold tracking-widest text-teal-700">
            {seriesCode ?? booking.code}
          </div>
        </div>
        <dl className="mt-5 space-y-1.5 text-sm">
          {[
            ["Venue", `${venue.name} (${venue.area})`],
            ["Court", court.name],
            ...(isSeries
              ? ([] as [string, string][])
              : ([["Date", booking.date]] as [string, string][])),
            ["Time", `${formatHour(booking.startHour)} – ${formatHour(booking.endHour)}`],
            [
              "Total",
              `RM${isSeries ? seriesTotal : booking.totalPrice} (pay at counter)`,
            ],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-slate-500">{label}</dt>
              <dd className="text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        {isSeries && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="font-semibold text-slate-700">Sessions</div>
            <ul className="mt-1 space-y-0.5">
              {bookings.map((b) => (
                <li key={b.id} className="flex justify-between">
                  <span>📅 {b.date}</span>
                  <span className="font-mono text-xs text-slate-500">
                    {b.code} · RM{b.totalPrice}
                  </span>
                </li>
              ))}
              {skipped.map((s) => (
                <li key={s.date} className="flex justify-between text-slate-400">
                  <span>📅 {s.date}</span>
                  <span className="text-xs">skipped — {s.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!isSeries && booking.checkInToken && <CheckInQr token={booking.checkInToken} />}
        <div className="mt-5 grid grid-cols-3 gap-2 text-xs font-medium">
          <a
            href={whatsappShareUrl(shareInfo)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 py-2 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
          >
            💬 WhatsApp
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
            ⬇️ .ics file
          </button>
        </div>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function SlotWaitlistModal({
  court,
  date,
  hour,
  onClose,
}: {
  court: Court;
  date: string;
  hour: number;
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
        if (!data.user) return;
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
          endHour: hour + 1,
          name,
          phone,
          email,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not join the waitlist");
      setPosition(data.position);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the waitlist");
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
            <h2 className="mt-2 text-xl font-bold">You&apos;re on the waitlist</h2>
            <p className="mt-1 text-sm text-slate-600">
              Number {position} for {court.name} at {formatHour(hour)}.
            </p>
            <p className="mt-3 text-xs text-slate-500">
              If it frees up, the slot is offered to whoever has waited longest. Signed-in
              customers see the offer on their account page.
            </p>
            <button
              onClick={onClose}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-bold">{court.name}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {date} · {formatHour(hour)} – {formatHour(hour + 1)}
            </p>
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This slot is taken. Join the waitlist and we&apos;ll offer it to you if it frees up.
            </p>
            <form onSubmit={submit} className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                Name
                <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Phone
                <input required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="012-345 6789" className={inputClass} />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Email (optional)
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-lg border border-slate-300 py-2 text-sm font-medium text-slate-600 hover:border-slate-400"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 rounded-lg bg-teal-600 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {busy ? "Joining…" : "Join waitlist"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
