"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Booking,
  Court,
  CourtAvailability,
  MAX_HOURS_PER_BOOKING,
  Sport,
  SPORT_ICONS,
  SPORT_LABELS,
} from "@/lib/types";
import { formatHour } from "@/lib/time";

interface Props {
  venueId: number;
  sports: Sport[];
  dates: string[];
}

interface Selection {
  courtId: number;
  hours: number[];
}

interface Confirmation {
  booking: Booking;
  court: Court;
  venue: { name: string; area: string };
}

function formatDateLabel(date: string): { day: string; num: string } {
  const d = new Date(`${date}T00:00:00Z`);
  return {
    day: d.toLocaleDateString("en-MY", { weekday: "short", timeZone: "UTC" }),
    num: d.toLocaleDateString("en-MY", { day: "numeric", month: "short", timeZone: "UTC" }),
  };
}

export default function BookingBoard({ venueId, sports, dates }: Props) {
  const [sport, setSport] = useState<Sport>(sports[0]);
  const [date, setDate] = useState<string>(dates[0]);
  const [availability, setAvailability] = useState<CourtAvailability[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

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
      setAvailability(data.availability);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load availability");
      setAvailability(null);
    } finally {
      setLoading(false);
    }
  }, [venueId, date, sport]);

  useEffect(() => {
    setSelection(null);
    loadAvailability();
  }, [loadAvailability]);

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
                    </div>
                  </td>
                  {slots.map((slot) => {
                    const isSelected =
                      selection?.courtId === court.id && selection.hours.includes(slot.hour);
                    return (
                      <td key={slot.hour} className="p-1 text-center">
                        <button
                          disabled={!slot.available}
                          onClick={() => toggleSlot(court.id, slot.hour)}
                          title={
                            slot.available
                              ? `${formatHour(slot.hour)} · RM${slot.rate}`
                              : "Unavailable"
                          }
                          className={`h-9 w-11 rounded-md text-xs font-medium transition ${
                            !slot.available
                              ? "cursor-not-allowed bg-slate-100 text-slate-300"
                              : isSelected
                                ? "bg-teal-600 text-white shadow"
                                : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          }`}
                        >
                          {slot.available ? slot.rate : "—"}
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
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courtId: court.id, date, hours, name, phone, email }),
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
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white shadow transition hover:bg-teal-700 disabled:opacity-50"
        >
          {submitting ? "Booking…" : `Book · RM${totalPrice}`}
        </button>
      </div>
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
  const { booking, court, venue } = confirmation;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="text-center">
          <div className="text-4xl">✅</div>
          <h2 className="mt-2 text-xl font-bold">Booking confirmed!</h2>
          <p className="mt-1 text-sm text-slate-600">
            Show this code at the counter. Save it — you&apos;ll need it (with your phone number)
            to view or cancel the booking.
          </p>
          <div className="mt-4 rounded-xl bg-teal-50 py-4 text-3xl font-bold tracking-widest text-teal-700">
            {booking.code}
          </div>
        </div>
        <dl className="mt-5 space-y-1.5 text-sm">
          {[
            ["Venue", `${venue.name} (${venue.area})`],
            ["Court", court.name],
            ["Date", booking.date],
            ["Time", `${formatHour(booking.startHour)} – ${formatHour(booking.endHour)}`],
            ["Total", `RM${booking.totalPrice} (pay at counter)`],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-slate-500">{label}</dt>
              <dd className="text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <button
          onClick={onClose}
          className="mt-6 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
        >
          Done
        </button>
      </div>
    </div>
  );
}
