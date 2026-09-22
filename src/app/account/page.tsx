"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatHour, todayISO } from "@/lib/time";
import { SPORT_ICONS } from "@/lib/types";
import type { User } from "@/lib/auth";
import type { UserBookingRow } from "@/lib/store";
import { downloadIcs, googleCalendarUrl, whatsappShareUrl } from "@/lib/booking-links";
import CheckInQr from "@/components/CheckInQr";
import Wallet from "@/components/Wallet";
import MyWaitlist from "@/components/MyWaitlist";

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [bookings, setBookings] = useState<UserBookingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const meRes = await fetch("/api/auth/me", { cache: "no-store" });
      const me = await meRes.json();
      if (!me.user) {
        router.replace("/login");
        return;
      }
      setUser(me.user);
      const res = await fetch("/api/my/bookings", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load bookings");
      setBookings(data.bookings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoaded(true);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  async function cancelSeries(seriesCode: string, phone: string) {
    if (!window.confirm(`Cancel ALL upcoming sessions in series ${seriesCode}?`)) return;
    setError(null);
    try {
      const res = await fetch("/api/bookings/cancel-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesCode, phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
    }
  }

  async function cancel(bookingId: number) {
    if (!window.confirm("Cancel this booking? The slots will be released.")) return;
    setError(null);
    try {
      const res = await fetch("/api/my/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
    }
  }

  if (!loaded || !user) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
        Loading…
      </div>
    );
  }

  const today = todayISO();
  const upcoming = (bookings ?? []).filter((b) => b.status === "confirmed" && b.date >= today);
  const past = (bookings ?? []).filter((b) => b.status !== "confirmed" || b.date < today);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Hi, {user.name} 👋</h1>
          <p className="mt-1 text-sm text-slate-600">
            {user.email} · {user.phone}
          </p>
        </div>
        <button
          onClick={logout}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-teal-600 hover:text-teal-700"
        >
          Sign out
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <Wallet />

      <MyWaitlist phone={user.phone} />

      <section>
        <h2 className="text-lg font-bold">Upcoming bookings</h2>
        {upcoming.length === 0 ? (
          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
            No upcoming bookings.{" "}
            <Link href="/" className="font-medium text-teal-700 underline">
              Book a court
            </Link>
          </div>
        ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {upcoming.map((b) => (
              <BookingCard
                key={b.id}
                booking={b}
                onCancel={() => cancel(b.id)}
                onCancelSeries={
                  b.seriesCode ? () => cancelSeries(b.seriesCode!, user.phone) : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="text-lg font-bold">Past &amp; cancelled</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  {["Code", "Court", "Date", "Time", "Total", "Status"].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {past.map((b) => (
                  <tr key={b.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-teal-700">{b.code}</td>
                    <td className="px-3 py-2">
                      {SPORT_ICONS[b.sport]} {b.courtName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{b.date}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatHour(b.startHour)} – {formatHour(b.endHour)}
                    </td>
                    <td className="px-3 py-2">RM{b.totalPrice}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          b.status === "confirmed"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {b.status === "confirmed" ? "played" : "cancelled"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function BookingCard({
  booking: b,
  onCancel,
  onCancelSeries,
}: {
  booking: UserBookingRow;
  onCancel: () => void;
  onCancelSeries?: () => void;
}) {
  const shareInfo = {
    code: b.code,
    date: b.date,
    startHour: b.startHour,
    endHour: b.endHour,
    courtName: b.courtName,
    venueName: b.venueName,
    venueAddress: b.venueAddress,
    totalPrice: b.totalPrice,
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="font-mono text-lg font-bold text-teal-700">{b.code}</div>
        <div className="flex items-center gap-1.5">
          {b.seriesCode && (
            <span
              className="rounded-full bg-violet-50 px-2.5 py-1 font-mono text-xs font-semibold text-violet-700"
              title="Part of a weekly series"
            >
              🔁 {b.seriesCode}
            </span>
          )}
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            Confirmed
          </span>
        </div>
      </div>
      <div className="mt-3 space-y-1 text-sm">
        <div className="font-semibold">
          {SPORT_ICONS[b.sport]} {b.courtName}
        </div>
        <div className="text-slate-600">
          {b.venueName} ({b.venueArea})
        </div>
        <div className="text-slate-600">
          📅 {b.date} · {formatHour(b.startHour)} – {formatHour(b.endHour)}
        </div>
        <div className="font-medium">
          RM{b.totalPrice}{" "}
          {b.paymentStatus === "paid" ? (
            <span className="text-emerald-700">✓ paid</span>
          ) : (
            <span className="text-slate-500">(pay at counter)</span>
          )}
        </div>
      </div>
      {b.checkedInAt ? (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-center text-xs font-medium text-emerald-700">
          ✓ Checked in
        </p>
      ) : (
        b.checkInToken && <CheckInQr token={b.checkInToken} />
      )}
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs font-medium">
        <a
          href={whatsappShareUrl(shareInfo)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-slate-300 py-1.5 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
        >
          💬 Share
        </a>
        <a
          href={googleCalendarUrl(shareInfo)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-slate-300 py-1.5 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
        >
          📅 Calendar
        </a>
        <button
          type="button"
          onClick={() => downloadIcs(shareInfo)}
          className="rounded-lg border border-slate-300 py-1.5 text-center text-slate-700 hover:border-teal-500 hover:text-teal-700"
        >
          ⬇️ .ics
        </button>
      </div>
      <div className={`mt-2 grid gap-2 ${onCancelSeries ? "grid-cols-2" : ""}`}>
        <button
          onClick={onCancel}
          className="w-full rounded-lg border border-red-300 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
        >
          Cancel booking
        </button>
        {onCancelSeries && (
          <button
            onClick={onCancelSeries}
            className="w-full rounded-lg border border-red-300 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
          >
            Cancel whole series
          </button>
        )}
      </div>
    </div>
  );
}
