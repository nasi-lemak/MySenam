"use client";

import { useState } from "react";
import { Booking, Court } from "@/lib/types";
import { formatHour } from "@/lib/time";
import { downloadIcs, googleCalendarUrl, whatsappShareUrl } from "@/lib/booking-links";
import CheckInQr from "@/components/CheckInQr";

interface Result {
  booking: Booking;
  court: Court;
  venue: { name: string; area: string; address: string; cancelCutoffHours: number };
}

export default function MyBookingPage() {
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/bookings?code=${encodeURIComponent(code)}&phone=${encodeURIComponent(phone)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!result) return;
    if (!window.confirm("Cancel this booking? The slots will be released.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      setResult({ ...result, booking: data.booking });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
    } finally {
      setBusy(false);
    }
  }

  const b = result?.booking;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My Booking</h1>
        <p className="mt-1 text-sm text-slate-600">
          Enter your booking code and the phone number you booked with.
        </p>
      </div>

      <form
        onSubmit={lookup}
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <label className="block text-sm font-medium text-slate-700">
          Booking code
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="MT-XXXXXX"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono tracking-wider focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Phone number
          <input
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="012-345 6789"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? "Please wait…" : "Find my booking"}
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {result && b && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="font-mono text-lg font-bold text-teal-700">{b.code}</div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                b.status === "confirmed"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-slate-100 text-slate-500"
              }`}
            >
              {b.status === "confirmed" ? "Confirmed" : "Cancelled"}
            </span>
          </div>
          <dl className="mt-4 space-y-1.5 text-sm">
            {[
              ["Venue", `${result.venue.name} (${result.venue.area})`],
              ["Address", result.venue.address],
              ["Court", result.court.name],
              ["Date", b.date],
              ["Time", `${formatHour(b.startHour)} – ${formatHour(b.endHour)}`],
              ["Booked by", b.name],
              [
                "Total",
                `RM${b.totalPrice}${b.paymentStatus === "paid" ? " ✓ paid" : " (pay at counter)"}`,
              ],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="shrink-0 text-slate-500">{label}</dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {b.status === "confirmed" && (
            <>
              {result.venue.cancelCutoffHours > 0 && (
                <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Free cancellation until {result.venue.cancelCutoffHours} hour
                  {result.venue.cancelCutoffHours === 1 ? "" : "s"} before your slot starts.
                </p>
              )}
              {b.checkedInAt ? (
                <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-center text-xs font-medium text-emerald-700">
                  ✓ Checked in
                </p>
              ) : (
                b.checkInToken && <CheckInQr token={b.checkInToken} />
              )}
              <div className="mt-5 grid grid-cols-3 gap-2 text-xs font-medium">
                {(() => {
                  const shareInfo = {
                    code: b.code,
                    date: b.date,
                    startHour: b.startHour,
                    endHour: b.endHour,
                    courtName: result.court.name,
                    venueName: result.venue.name,
                    venueAddress: result.venue.address,
                    totalPrice: b.totalPrice,
                  };
                  return (
                    <>
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
                    </>
                  );
                })()}
              </div>
              <button
                onClick={cancel}
                disabled={busy}
                className="mt-3 w-full rounded-lg border border-red-300 py-2.5 font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Cancel booking
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
