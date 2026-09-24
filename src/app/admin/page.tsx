"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import {
  ClassSession,
  Court,
  isShared,
  MAX_CAPACITY,
  MAX_CLASS_WEEKS,
  MAX_TOP_UP,
  SPORT_ICONS,
  SPORT_LABELS,
  WalletEntry,
  MAX_PASS_ENTRIES,
  Membership,
  MAX_PROMO_AMOUNT,
  MAX_PROMO_PERCENT,
  MAX_HOURS_PER_BOOKING,
  PromoCode,
  Pass,
  Venue,
  VenueClosure,
  OPEN_HOUR,
  CLOSE_HOUR,
} from "@/lib/types";
import type { Booking } from "@/lib/types";
import type { Admin } from "@/lib/admin-auth";
import type { AdminBookingRow, AdminCourtSlots, OccupancyReport } from "@/lib/store";

type Tab = "bookings" | "schedule" | "occupancy" | "courts" | "classes" | "credit" | "venues";

type ManagedVenue = Venue & { courts: Court[] };

/** A UTC timestamp as Malaysia-time HH:MM. */
function localTime(iso: string): string {
  return new Date(iso.includes("Z") || iso.includes("+") ? iso : `${iso.replace(" ", "T")}Z`)
    .toLocaleTimeString("en-MY", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Kuala_Lumpur",
    });
}

/** Every hour a venue may open or close on. */
const HOUR_CHOICES = Array.from(
  { length: CLOSE_HOUR - OPEN_HOUR + 1 },
  (_, i) => OPEN_HOUR + i
);

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
}

export default function AdminPage() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [venues, setVenues] = useState<ManagedVenue[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("bookings");

  /** Re-read the session and the venues this admin may manage. */
  const refreshVenues = useCallback(async () => {
    const res = await fetch("/api/admin/auth/me", { cache: "no-store" });
    const data = await res.json();
    setAdmin(data.admin);
    setVenues(data.venues);
    return data.admin as Admin | null;
  }, []);

  useEffect(() => {
    refreshVenues()
      .catch(() => setAdmin(null))
      .finally(() => setLoaded(true));
  }, [refreshVenues]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sign-in failed");
      await refreshVenues();
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/auth/logout", { method: "POST" });
    setAdmin(null);
    setVenues([]);
  }

  if (!loaded) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
        Loading…
      </div>
    );
  }

  if (!admin) {
    return (
      <div className="mx-auto max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Venue admin</h1>
          <p className="mt-1 text-sm text-slate-600">
            Sign in with your operator account to manage your venue.
          </p>
        </div>
        <form
          onSubmit={signIn}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <label className="block text-sm font-medium text-slate-700">
            Email
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@venue.com"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Checking…" : "Sign in"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </div>
    );
  }

  const isOwner = admin.venueId === null;
  const tabs: [Tab, string][] = [
    ["bookings", "Bookings"],
    ["schedule", "Court schedule"],
    ["occupancy", "Occupancy"],
    ["courts", "Courts & rates"],
    ["classes", "Classes"],
    ["credit", "Credit & passes"],
    ["venues", isOwner ? "Venues & staff" : "Venue details"],
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Admin dashboard</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {admin.name} ·{" "}
            {isOwner ? (
              <span className="font-medium text-teal-700">Platform owner — all venues</span>
            ) : (
              <span className="font-medium text-teal-700">
                {venues[0]?.name ?? "Your venue"}
              </span>
            )}
          </p>
        </div>
        <button onClick={signOut} className="text-sm text-slate-500 underline hover:text-teal-700">
          Sign out
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              tab === id
                ? "bg-teal-600 text-white shadow"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {venues.length === 0 && tab !== "venues" ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          No venues yet. Create one in the{" "}
          <button onClick={() => setTab("venues")} className="font-medium text-teal-700 underline">
            Venues &amp; staff
          </button>{" "}
          tab.
        </div>
      ) : (
        <>
          {tab === "bookings" && <BookingsTab />}
          {tab === "schedule" && <ScheduleTab venues={venues} />}
          {tab === "occupancy" && <OccupancyTab venues={venues} />}
          {tab === "courts" && <CourtsTab venues={venues} onVenuesChange={refreshVenues} />}
          {tab === "classes" && <ClassesTab venues={venues} />}
          {tab === "credit" && <CreditTab venues={venues} />}
          {tab === "venues" && (
            <VenuesTab admin={admin} venues={venues} onChange={refreshVenues} />
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- Bookings tab ---------------- */

function BookingsTab() {
  const [date, setDate] = useState(todayLocal);
  const [bookings, setBookings] = useState<AdminBookingRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The booking being moved, and the courts it could go to.
  const [moving, setMoving] = useState<{ code: string; courts: Court[] } | null>(null);
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
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
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {[
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
                  "",
                ].map((h, i) => (
                  <th key={i} className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-mono font-medium text-teal-700">
                    {b.code}
                    {b.seriesCode && (
                      <button
                        onClick={() => paySeries(b.seriesCode!)}
                        title={`Mark all unpaid sessions in ${b.seriesCode} as paid`}
                        className="ml-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 hover:bg-violet-100"
                      >
                        🔁
                      </button>
                    )}
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
                    {b.priorNoShows > 0 && (
                      <span
                        title={`${b.priorNoShows} previous no-show${b.priorNoShows > 1 ? "s" : ""}`}
                        className="ml-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600"
                      >
                        ⚠ {b.priorNoShows}
                      </span>
                    )}
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
                    {b.status === "confirmed" ? (
                      <button
                        onClick={() => togglePaid(b.code, b.paymentStatus !== "paid")}
                        title={
                          b.paymentStatus === "paid"
                            ? "Click to mark unpaid"
                            : "Click to mark paid"
                        }
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${
                          b.paymentStatus === "paid"
                            ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                            : "bg-amber-100 text-amber-700 hover:bg-amber-200"
                        }`}
                      >
                        {b.paymentStatus === "paid" ? "✓ paid" : "unpaid"}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {b.status !== "confirmed" ? (
                      <span className="text-xs text-slate-400">—</span>
                    ) : b.checkedInAt ? (
                      <button
                        onClick={() => toggleCheckIn(b.code, !b.checkedOutAt)}
                        title={
                          b.checkedOutAt
                            ? `Left at ${localTime(b.checkedOutAt)}`
                            : `Arrived ${localTime(b.checkedInAt)} — click to check out`
                        }
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${
                          b.checkedOutAt
                            ? "bg-slate-100 text-slate-500"
                            : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                        }`}
                      >
                        {b.checkedOutAt ? `left ${localTime(b.checkedOutAt)}` : `in ${localTime(b.checkedInAt)}`}
                      </button>
                    ) : (
                      <div className="flex gap-1">
                        <button
                          onClick={() => toggleCheckIn(b.code, false)}
                          title="Check the customer in at the desk"
                          className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-700 transition hover:bg-teal-100"
                        >
                          check in
                        </button>
                        <button
                          onClick={() => toggleNoShow(b.code, !b.noShow)}
                          title={
                            b.noShow ? "Click to clear the no-show" : "Mark the customer as a no-show"
                          }
                          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${
                            b.noShow
                              ? "bg-red-100 text-red-700 hover:bg-red-200"
                              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                          }`}
                        >
                          {b.noShow ? "no-show" : "no-show?"}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {b.status === "confirmed" && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button
                          onClick={() => openMove(b.code)}
                          title="Put this booking on another court, keeping its code and payment"
                          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
                        >
                          Move
                        </button>
                        <button
                          onClick={() => cancelBooking(b.code)}
                          className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Court schedule tab ---------------- */

function ScheduleTab({
  venues,
}: {
  venues: (Venue & { courts: Court[] })[];
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [date, setDate] = useState(todayLocal);
  const [reason, setReason] = useState("");
  // Blank takes the whole resource out; a number takes that many places.
  const [placesOut, setPlacesOut] = useState("");
  const [courts, setCourts] = useState<AdminCourtSlots[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/slots?venueId=${venueId}&date=${date}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setCourts(data.courts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setCourts(null);
    }
  }, [venueId, date]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(courtId: number, hour: number, status: string) {
    if (status !== "free" && status !== "blocked" && status !== "past") return;
    setError(null);
    const court = courts?.find((c) => c.court.id === courtId)?.court;
    // Places only mean anything on a shared facility.
    const places =
      placesOut.trim() !== "" && court && court.capacity > 1 ? Number(placesOut) : undefined;
    try {
      const res = await fetch("/api/admin/blocks", {
        method: status === "blocked" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courtId, date, hours: [hour], reason: reason || undefined, places }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={venueId}
          onChange={(e) => setVenueId(Number(e.target.value))}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        >
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Block reason (optional)"
          className="w-52 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          type="number"
          min={1}
          value={placesOut}
          onChange={(e) => setPlacesOut(e.target.value)}
          placeholder="Places out"
          title="Shared facilities only: how many places to take out. Blank takes the whole thing."
          className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
      </div>
      <p className="text-sm text-slate-500">
        Click a <span className="font-medium text-emerald-700">free</span> slot to block it for
        maintenance; click a <span className="font-medium text-amber-700">blocked</span> slot to
        release it. Booked slots show the booking code. On a shared facility — a gym floor, a
        kayak fleet — set <strong>places out</strong> to take only some out of service and leave
        the rest bookable.
      </p>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {courts && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[980px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-semibold">Court</th>
                {courts[0]?.slots.map((s) => (
                  <th key={s.hour} className="px-1 py-2 text-center font-medium text-slate-500">
                    {formatHour(s.hour).replace(":00 ", "")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {courts.map(({ court, slots }) => (
                <tr key={court.id} className="border-b border-slate-100 last:border-0">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-2 font-medium">
                    {SPORT_ICONS[court.sport]} {court.name}
                    {isShared(court) && (
                      <span className="ml-1 text-xs font-normal text-slate-400">
                        {court.capacity} places
                      </span>
                    )}
                  </td>
                  {slots.map((slot) => (
                    <td key={slot.hour} className="p-1 text-center">
                      <button
                        onClick={() => toggle(court.id, slot.hour, slot.status)}
                        disabled={slot.status === "booked"}
                        title={
                          isShared(court)
                            ? `${slot.booked} of ${court.capacity} places taken` +
                              (slot.blockedPlaces
                                ? ` · ${slot.blockedPlaces} out of service${slot.blockReason ? ` (${slot.blockReason})` : ""}`
                                : slot.status === "blocked"
                                  ? ` · all out${slot.blockReason ? ` (${slot.blockReason})` : ""} — click to release`
                                  : "")
                            : slot.status === "booked"
                              ? `Booked: ${slot.bookingCode}`
                              : slot.status === "blocked"
                                ? `Blocked${slot.blockReason ? `: ${slot.blockReason}` : ""} — click to release`
                                : slot.status === "past"
                                  ? "Past — can still block/unblock"
                                  : "Free — click to block"
                        }
                        className={`h-9 w-12 rounded-md text-[10px] font-semibold transition ${
                          slot.status === "booked"
                            ? "cursor-default bg-slate-200 text-slate-600"
                            : slot.status === "blocked"
                              ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                              : slot.blockedPlaces
                                ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                                : slot.status === "past"
                                ? "bg-slate-50 text-slate-300 hover:bg-slate-100"
                                : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        }`}
                      >
                        {isShared(court) && slot.status !== "blocked"
                          ? slot.blockedPlaces
                            ? `${slot.booked}/${court.capacity - slot.blockedPlaces}`
                            : `${slot.booked}/${court.capacity}`
                          : slot.status === "booked"
                            ? slot.bookingCode?.slice(3)
                            : slot.status === "blocked"
                              ? "⛔"
                              : slot.status === "past"
                                ? "—"
                                : "·"}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------- Courts & rates tab ---------------- */

function CourtsTab({
  venues,
  onVenuesChange,
}: {
  venues: (Venue & { courts: Court[] })[];
  onVenuesChange: (venues: (Venue & { courts: Court[] })[]) => void;
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newCourt, setNewCourt] = useState({
    name: "",
    sport: "badminton",
    offPeak: "",
    peak: "",
    capacity: "1",
  });

  const venue = venues.find((v) => v.id === venueId);

  async function refreshVenues() {
    const res = await fetch("/api/venues", { cache: "no-store" });
    const data = await res.json();
    onVenuesChange(data.venues);
  }

  async function saveCourt(
    court: Court,
    name: string,
    offPeak: string,
    peak: string,
    capacity: string,
    memberOffPeak: string,
    memberPeak: string
  ) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${court.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          offPeakRate: Number(offPeak),
          peakRate: Number(peak),
          capacity: Number(capacity),
          // Blank means "no member discount on this court".
          memberOffPeakRate: memberOffPeak.trim() === "" ? null : Number(memberOffPeak),
          memberPeakRate: memberPeak.trim() === "" ? null : Number(memberPeak),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      setNotice(`Saved ${data.court.name}.`);
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function addCourt(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/courts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          name: newCourt.name,
          sport: newCourt.sport,
          offPeakRate: Number(newCourt.offPeak),
          peakRate: Number(newCourt.peak),
          capacity: Number(newCourt.capacity),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not add court");
      setNotice(`Added ${data.court.name}.`);
      setNewCourt({ name: "", sport: newCourt.sport, offPeak: "", peak: "", capacity: "1" });
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add court");
    }
  }

  return (
    <div className="space-y-4">
      <select
        value={venueId}
        onChange={(e) => setVenueId(Number(e.target.value))}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
      >
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {venue && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {[
                  "Court", "Sport", "Off-peak (RM/hr)", "Peak (RM/hr)",
                  "Member off-peak", "Member peak", "Capacity", "",
                ].map((h, i) => (
                  <th key={i} className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {venue.courts.map((court) => (
                <CourtRow key={court.id} court={court} onSave={saveCourt} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        onSubmit={addCourt}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-slate-300 bg-white p-4"
      >
        <div className="text-sm font-semibold text-slate-700">Add court:</div>
        <input
          required
          minLength={2}
          value={newCourt.name}
          onChange={(e) => setNewCourt({ ...newCourt, name: e.target.value })}
          placeholder="Court name"
          className="w-44 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <select
          value={newCourt.sport}
          onChange={(e) => setNewCourt({ ...newCourt, sport: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        >
          {Object.entries(SPORT_ICONS).map(([sport, icon]) => (
            <option key={sport} value={sport}>
              {icon} {sport}
            </option>
          ))}
        </select>
        <input
          required
          type="number"
          min={1}
          value={newCourt.offPeak}
          onChange={(e) => setNewCourt({ ...newCourt, offPeak: e.target.value })}
          placeholder="Off-peak RM"
          className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          required
          type="number"
          min={1}
          value={newCourt.peak}
          onChange={(e) => setNewCourt({ ...newCourt, peak: e.target.value })}
          placeholder="Peak RM"
          className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          required
          type="number"
          min={1}
          max={MAX_CAPACITY}
          value={newCourt.capacity}
          onChange={(e) => setNewCourt({ ...newCourt, capacity: e.target.value })}
          title="1 for an exclusive court; higher for a shared facility like a gym floor"
          placeholder="Capacity"
          className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Add
        </button>
      </form>
    </div>
  );
}

function CourtRow({
  court,
  onSave,
}: {
  court: Court;
  onSave: (
    court: Court,
    name: string,
    offPeak: string,
    peak: string,
    capacity: string,
    memberOffPeak: string,
    memberPeak: string
  ) => void;
}) {
  const [name, setName] = useState(court.name);
  const [offPeak, setOffPeak] = useState(String(court.offPeakRate));
  const [peak, setPeak] = useState(String(court.peakRate));
  const [capacity, setCapacity] = useState(String(court.capacity));
  const [memberOffPeak, setMemberOffPeak] = useState(
    court.memberOffPeakRate === null ? "" : String(court.memberOffPeakRate)
  );
  const [memberPeak, setMemberPeak] = useState(
    court.memberPeakRate === null ? "" : String(court.memberPeakRate)
  );
  const asText = (v: number | null) => (v === null ? "" : String(v));
  const dirty =
    name !== court.name ||
    offPeak !== String(court.offPeakRate) ||
    peak !== String(court.peakRate) ||
    capacity !== String(court.capacity) ||
    memberOffPeak !== asText(court.memberOffPeakRate) ||
    memberPeak !== asText(court.memberPeakRate);

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="px-3 py-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-44 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        {SPORT_ICONS[court.sport]} {court.sport}
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={1}
          value={offPeak}
          onChange={(e) => setOffPeak(e.target.value)}
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={1}
          value={peak}
          onChange={(e) => setPeak(e.target.value)}
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={0}
          value={memberOffPeak}
          onChange={(e) => setMemberOffPeak(e.target.value)}
          placeholder="—"
          title="What a member pays off-peak. Leave blank for no member discount."
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={0}
          value={memberPeak}
          onChange={(e) => setMemberPeak(e.target.value)}
          placeholder="—"
          title="What a member pays at peak. Leave blank for no member discount."
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={1}
          max={MAX_CAPACITY}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          title="1 for an exclusive court; higher for a shared facility"
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <button
          disabled={!dirty}
          onClick={() => onSave(court, name, offPeak, peak, capacity, memberOffPeak, memberPeak)}
          className="rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-30"
        >
          Save
        </button>
      </td>
    </tr>
  );
}

/* ---------------- Occupancy tab ---------------- */

function OccupancyTab({
  venues,
}: {
  venues: (Venue & { courts: Court[] })[];
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [report, setReport] = useState<OccupancyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/occupancy?venueId=${venueId}&days=7`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setReport(null);
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  function heat(pct: number): string {
    if (pct === 0) return "bg-white text-slate-400";
    if (pct < 25) return "bg-teal-50 text-teal-700";
    if (pct < 50) return "bg-teal-100 text-teal-800";
    if (pct < 75) return "bg-teal-300 text-teal-900";
    return "bg-teal-600 text-white";
  }

  return (
    <div className="space-y-4">
      <select
        value={venueId}
        onChange={(e) => setVenueId(Number(e.target.value))}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
      >
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {report && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th className="px-3 py-2 font-semibold">Court</th>
                {report.days.map((d) => (
                  <th key={d.date} className="px-2 py-2 text-center font-medium text-slate-500">
                    {new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-MY", {
                      weekday: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.courts.map((court) => (
                <tr key={court.id} className="border-b border-slate-100 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 font-medium">
                    {SPORT_ICONS[court.sport]} {court.name}
                  </td>
                  {report.days.map((d) => {
                    const cell = d.perCourt.find((c) => c.courtId === court.id);
                    const booked = cell?.booked ?? 0;
                    const places = report.totalSlotsPerDay * court.capacity;
                    const pct = Math.round((booked / places) * 100);
                    return (
                      <td key={d.date} className="p-1 text-center">
                        <div
                          className={`rounded-md py-1.5 text-xs font-semibold ${heat(pct)}`}
                          title={`${booked}/${places} places booked${cell?.blocked ? `, ${cell.blocked} hours blocked` : ""}`}
                        >
                          {booked > 0 ? `${pct}%` : "·"}
                          {cell?.blocked ? <span className="ml-0.5">⛔</span> : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="px-3 py-2">Venue total</td>
                {report.days.map((d) => {
                  const booked = d.perCourt.reduce((s, c) => s + c.booked, 0);
                  const total = report.courts.reduce(
                    (sum, c) => sum + report.totalSlotsPerDay * c.capacity,
                    0
                  );
                  const pct = total > 0 ? Math.round((booked / total) * 100) : 0;
                  return (
                    <td key={d.date} className="px-2 py-2 text-center text-teal-700">
                      {pct}%
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------- Venues & staff tab ---------------- */

function VenuesTab({
  admin,
  venues,
  onChange,
}: {
  admin: Admin;
  venues: ManagedVenue[];
  onChange: () => Promise<Admin | null>;
}) {
  const isOwner = admin.venueId === null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [newVenue, setNewVenue] = useState({ name: "", area: "", address: "", phone: "" });
  const [newStaff, setNewStaff] = useState({ name: "", email: "", password: "", venueId: "" });

  const loadAdmins = useCallback(async () => {
    if (!isOwner) return;
    const res = await fetch("/api/admin/admins", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setAdmins(data.admins);
  }, [isOwner]);

  useEffect(() => {
    loadAdmins();
  }, [loadAdmins]);

  async function send(
    url: string,
    method: string,
    body: unknown,
    okMessage: string,
    after?: () => void
  ) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setNotice(okMessage);
      await onChange();
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <section>
        <h2 className="text-lg font-bold">{isOwner ? "Venues" : "Venue details"}</h2>
        <div className="mt-3 space-y-3">
          {venues.map((venue) => (
            <VenueRow key={venue.id} venue={venue} onSave={send} />
          ))}
          {venues.length === 0 && (
            <p className="text-sm text-slate-500">No venues yet.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-bold">Closed days</h2>
        <p className="mt-1 text-sm text-slate-500">
          Shut a venue for a whole day — a public holiday, a private hire, a refit.
          Nobody can book or join a waitlist for that date.
        </p>
        <div className="mt-3 space-y-3">
          {venues.map((venue) => (
            <ClosuresRow key={venue.id} venue={venue} onError={setError} onNotice={setNotice} />
          ))}
        </div>
      </section>

      {isOwner && (
        <>
          <section>
            <h3 className="font-semibold text-slate-700">Add a venue</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send("/api/admin/venues", "POST", newVenue, `Added ${newVenue.name}.`, () =>
                  setNewVenue({ name: "", area: "", address: "", phone: "" })
                );
              }}
              className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
            >
              <input
                required minLength={2} placeholder="Venue name" value={newVenue.name}
                onChange={(e) => setNewVenue({ ...newVenue, name: e.target.value })}
                className={`w-48 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder="Area (e.g. Cheras)" value={newVenue.area}
                onChange={(e) => setNewVenue({ ...newVenue, area: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder="Address" value={newVenue.address}
                onChange={(e) => setNewVenue({ ...newVenue, address: e.target.value })}
                className={`w-64 ${inputClass}`}
              />
              <input
                required minLength={2} placeholder="Phone" value={newVenue.phone}
                onChange={(e) => setNewVenue({ ...newVenue, phone: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <button
                type="submit"
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                Add venue
              </button>
            </form>
          </section>

          <section>
            <h2 className="text-lg font-bold">Staff accounts</h2>
            <p className="mt-1 text-sm text-slate-600">
              A venue operator only ever sees their own venue&apos;s bookings, schedule and
              revenue. Leave the venue blank to create another platform owner.
            </p>
            {admins && (
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      {["Name", "Email", "Scope", ""].map((h, i) => (
                        <th key={i} className="px-3 py-2 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {admins.map((a) => (
                      <tr key={a.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-3 py-2 font-medium">{a.name}</td>
                        <td className="px-3 py-2">{a.email}</td>
                        <td className="px-3 py-2">
                          {a.venueId === null ? (
                            <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-700">
                              platform owner
                            </span>
                          ) : (
                            <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-700">
                              {venues.find((v) => v.id === a.venueId)?.name ?? `Venue ${a.venueId}`}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {a.id !== admin.id && (
                            <button
                              onClick={() => {
                                if (!window.confirm(`Remove ${a.email}?`)) return;
                                send(`/api/admin/admins/${a.id}`, "DELETE", undefined, "Removed.", loadAdmins);
                              }}
                              className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(
                  "/api/admin/admins",
                  "POST",
                  { ...newStaff, venueId: newStaff.venueId ? Number(newStaff.venueId) : null },
                  `Added ${newStaff.email}.`,
                  () => {
                    setNewStaff({ name: "", email: "", password: "", venueId: "" });
                    loadAdmins();
                  }
                );
              }}
              className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
            >
              <input
                required minLength={2} placeholder="Name" value={newStaff.name}
                onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <input
                required type="email" placeholder="Email" value={newStaff.email}
                onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
                className={`w-52 ${inputClass}`}
              />
              <input
                required type="password" minLength={8} placeholder="Password (8+)"
                value={newStaff.password}
                onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
                className={`w-40 ${inputClass}`}
              />
              <select
                value={newStaff.venueId}
                onChange={(e) => setNewStaff({ ...newStaff, venueId: e.target.value })}
                className={inputClass}
              >
                <option value="">Platform owner (all venues)</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                Add staff
              </button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}

/** Whole-day closures for one venue: list, add, remove. */
function ClosuresRow({
  venue,
  onError,
  onNotice,
}: {
  venue: ManagedVenue;
  onError: (msg: string | null) => void;
  onNotice: (msg: string | null) => void;
}) {
  const [closures, setClosures] = useState<VenueClosure[]>([]);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/venues/${venue.id}/closures`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setClosures(data.closures);
  }, [venue.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function send(url: string, method: string, body?: unknown, okMessage?: string) {
    onError(null);
    onNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      if (okMessage) onNotice(okMessage);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Request failed");
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold">{venue.name}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {closures.length === 0 && (
          <span className="text-xs text-slate-400">No closures scheduled.</span>
        )}
        {closures.map((c) => (
          <span
            key={c.date}
            className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800"
          >
            {c.date}
            {c.reason ? ` · ${c.reason}` : ""}
            <button
              onClick={() =>
                send(
                  `/api/admin/venues/${venue.id}/closures?date=${c.date}`,
                  "DELETE",
                  undefined,
                  `Re-opened ${c.date}.`
                )
              }
              title="Re-open this day"
              className="font-bold text-amber-700 hover:text-amber-900"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Date
          <input
            type="date"
            min={todayLocal()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Reason (optional)
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Hari Raya"
            className="mt-1 w-56 rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
        <button
          disabled={!date}
          onClick={() =>
            send(
              `/api/admin/venues/${venue.id}/closures`,
              "POST",
              { date, reason },
              `Closed ${date}.`
            ).then(() => {
              setDate("");
              setReason("");
            })
          }
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-30"
        >
          Close day
        </button>
      </div>
    </div>
  );
}

function VenueRow({
  venue,
  onSave,
}: {
  venue: ManagedVenue;
  onSave: (
    url: string,
    method: string,
    body: unknown,
    okMessage: string,
    after?: () => void
  ) => Promise<void>;
}) {
  const [fields, setFields] = useState({
    name: venue.name,
    area: venue.area,
    address: venue.address,
    phone: venue.phone,
    cancelCutoffHours: venue.cancelCutoffHours,
    openHour: venue.openHour,
    closeHour: venue.closeHour,
  });
  const dirty =
    fields.name !== venue.name ||
    fields.area !== venue.area ||
    fields.address !== venue.address ||
    fields.phone !== venue.phone ||
    fields.cancelCutoffHours !== venue.cancelCutoffHours ||
    fields.openHour !== venue.openHour ||
    fields.closeHour !== venue.closeHour;

  const inputClass =
    "rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Name
        <input
          value={fields.name}
          onChange={(e) => setFields({ ...fields, name: e.target.value })}
          className={`mt-1 w-52 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Area
        <input
          value={fields.area}
          onChange={(e) => setFields({ ...fields, area: e.target.value })}
          className={`mt-1 w-36 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Address
        <input
          value={fields.address}
          onChange={(e) => setFields({ ...fields, address: e.target.value })}
          className={`mt-1 w-72 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Phone
        <input
          value={fields.phone}
          onChange={(e) => setFields({ ...fields, phone: e.target.value })}
          className={`mt-1 w-36 ${inputClass}`}
        />
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Opens
        <select
          value={fields.openHour}
          onChange={(e) => setFields({ ...fields, openHour: Number(e.target.value) })}
          className={`mt-1 w-24 ${inputClass}`}
        >
          {HOUR_CHOICES.filter((h) => h < CLOSE_HOUR).map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Closes
        <select
          value={fields.closeHour}
          onChange={(e) => setFields({ ...fields, closeHour: Number(e.target.value) })}
          className={`mt-1 w-24 ${inputClass}`}
        >
          {HOUR_CHOICES.filter((h) => h > fields.openHour).map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        Cancel cutoff (hrs)
        <input
          type="number"
          min={0}
          max={72}
          value={fields.cancelCutoffHours}
          onChange={(e) =>
            setFields({ ...fields, cancelCutoffHours: Number(e.target.value) })
          }
          title="Customers can cancel until this many hours before a booking starts"
          className={`mt-1 w-24 ${inputClass}`}
        />
      </label>
      <span className="text-xs text-slate-400">{venue.courts.length} courts</span>
      <button
        disabled={!dirty}
        onClick={() => onSave(`/api/admin/venues/${venue.id}`, "PATCH", fields, `Saved ${fields.name}.`)}
        className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-30"
      >
        Save
      </button>
    </div>
  );
}

/* ---------------- Classes tab ---------------- */

function ClassesTab({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [classes, setClasses] = useState<ClassSession[] | null>(null);
  const [roster, setRoster] = useState<{
    session: ClassSession;
    roster: Booking[];
    waitlist?: { id: number; name: string; phone: string; status: string }[];
  } | null>(null);
  const [waiting, setWaiting] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    courtId: "",
    name: "",
    instructor: "",
    date: todayLocal(),
    startHour: "19",
    endHour: "20",
    capacity: "12",
    price: "25",
    weeks: "1",
  });

  const venue = venues.find((v) => v.id === venueId);
  // Only shared facilities can host a class; a single court has one place.
  const hostable = (venue?.courts ?? []).filter((c) => c.capacity > 1);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/classes?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load classes");
      setClasses(data.classes);
      setWaiting(data.waiting ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load classes");
      setClasses(null);
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function schedule(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtId: Number(form.courtId),
          name: form.name,
          instructor: form.instructor,
          date: form.date,
          startHour: Number(form.startHour),
          endHour: Number(form.endHour),
          capacity: Number(form.capacity),
          price: Number(form.price),
          weeks: Number(form.weeks),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not schedule the class");
      setNotice(
        data.classes.length > 1
          ? `Scheduled ${data.classes.length} weekly sessions (${data.seriesCode}).`
          : `Scheduled ${form.name}.`
      );
      setForm({ ...form, name: "", instructor: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not schedule the class");
    }
  }

  async function cancelClass(session: ClassSession) {
    if (
      !window.confirm(
        `Cancel ${session.name} on ${session.date}? ${session.enrolled} enrolment(s) will be released.`
      )
    )
      return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/classes/${session.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      setNotice(`Cancelled — ${data.released} enrolment(s) released.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
    }
  }

  async function openRoster(session: ClassSession) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/classes/${session.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load roster");
      setRoster(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load roster");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-4">
      <select
        value={venueId}
        onChange={(e) => setVenueId(Number(e.target.value))}
        className={inputClass}
      >
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {classes && classes.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {["Class", "Instructor", "Where", "When", "Enrolled", "Waiting", "Price", "", ""].map(
                  (h, i) => (
                    <th key={i} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {classes.map((session) => (
                <tr key={session.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-medium">
                    {session.name}
                    {session.seriesCode && (
                      <span className="ml-1 rounded-full bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-violet-700">
                        🔁
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{session.instructor}</td>
                  <td className="px-3 py-2">
                    {SPORT_ICONS[session.sport]} {session.courtName}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {session.date} · {formatHour(session.startHour)}–{formatHour(session.endHour)}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => openRoster(session)}
                      className="font-medium text-teal-700 underline"
                    >
                      {session.enrolled}/{session.capacity}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    {waiting[session.id] ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                        {waiting[session.id]}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">RM{session.price}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        session.status === "scheduled"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {session.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {session.status === "scheduled" && (
                      <button
                        onClick={() => cancelClass(session)}
                        className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
          No classes scheduled here yet.
        </div>
      )}

      {hostable.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          Classes need a shared facility to run in. Give a resource a capacity above 1 in{" "}
          <span className="font-medium">Courts &amp; rates</span> first.
        </p>
      ) : (
        <form
          onSubmit={schedule}
          className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
        >
          <div className="w-full text-sm font-semibold text-slate-700">Schedule a class</div>
          <input
            required minLength={2} placeholder="Class name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`w-40 ${inputClass}`}
          />
          <input
            required minLength={2} placeholder="Instructor" value={form.instructor}
            onChange={(e) => setForm({ ...form, instructor: e.target.value })}
            className={`w-36 ${inputClass}`}
          />
          <select
            required value={form.courtId}
            onChange={(e) => setForm({ ...form, courtId: e.target.value })}
            className={inputClass}
          >
            <option value="">Where…</option>
            {hostable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.capacity})
              </option>
            ))}
          </select>
          <input
            required type="date" value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className={inputClass}
          />
          <input
            required type="number" min={8} max={22} value={form.startHour}
            onChange={(e) => setForm({ ...form, startHour: e.target.value })}
            title="Start hour" className={`w-20 ${inputClass}`}
          />
          <input
            required type="number" min={9} max={23} value={form.endHour}
            onChange={(e) => setForm({ ...form, endHour: e.target.value })}
            title="End hour" className={`w-20 ${inputClass}`}
          />
          <input
            required type="number" min={1} value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            title="Seats" className={`w-20 ${inputClass}`}
          />
          <input
            required type="number" min={0} value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            title="Price per person (RM)" className={`w-20 ${inputClass}`}
          />
          <select
            value={form.weeks}
            onChange={(e) => setForm({ ...form, weeks: e.target.value })}
            title="Repeat weekly"
            className={inputClass}
          >
            {Array.from({ length: MAX_CLASS_WEEKS }, (_, i) => i + 1).map((w) => (
              <option key={w} value={w}>
                {w === 1 ? "Once" : `${w} weeks`}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
          >
            Schedule
          </button>
        </form>
      )}

      {roster && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold">{roster.session.name}</h3>
            <p className="mt-1 text-sm text-slate-600">
              {roster.session.date} · {formatHour(roster.session.startHour)}–
              {formatHour(roster.session.endHour)} with {roster.session.instructor}
            </p>
            {roster.waitlist && roster.waitlist.length > 0 && (
              <div className="mt-4 rounded-lg bg-amber-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                  Waiting ({roster.waitlist.length})
                </div>
                <ul className="mt-1 space-y-1 text-sm text-amber-900">
                  {roster.waitlist.map((w) => (
                    <li key={w.id} className="flex items-center justify-between gap-3">
                      <span>
                        {w.name}
                        <span className="ml-2 text-xs opacity-70">{w.phone}</span>
                      </span>
                      {w.status === "offered" && (
                        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold">
                          offered
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {roster.roster.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">Nobody has enrolled yet.</p>
            ) : (
              <ul className="mt-4 space-y-1.5 text-sm">
                {roster.roster.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3">
                    <span className={b.status === "cancelled" ? "text-slate-400 line-through" : ""}>
                      {b.name}
                      <span className="ml-2 text-xs text-slate-400">{b.phone}</span>
                    </span>
                    {b.status === "confirmed" && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          b.checkedInAt
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {b.checkedInAt ? "checked in" : "expected"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => setRoster(null)}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2 font-semibold text-white hover:bg-teal-700"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Credit tab ---------------- */

interface WalletCustomer {
  id: number;
  name: string;
  email: string;
  phone: string;
  balance: number;
}

function CreditTab({ venues }: { venues: ManagedVenue[] }) {
  const [query, setQuery] = useState("");
  const [customer, setCustomer] = useState<WalletCustomer | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [amount, setAmount] = useState("50");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/wallet?q=${encodeURIComponent(query)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed");
      setCustomer(data.customer);
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
      setCustomer(null);
      setEntries([]);
    }
  }

  async function topUp() {
    if (!customer) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: customer.id, amount: Number(amount) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Top-up failed");
      setNotice(`Added RM${amount}. New balance RM${data.balance}.`);
      setCustomer({ ...customer, balance: data.balance });
      setEntries([data.entry, ...entries]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Top-up failed");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-6">
      <div className="max-w-2xl space-y-4">
      <p className="text-sm text-slate-600">
        Sell credit at the counter. Customers can then pay for bookings and classes from their
        balance instead of cash.
      </p>

      <form onSubmit={lookup} className="flex flex-wrap items-end gap-2">
        <input
          required
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Customer email or phone"
          className={`w-64 ${inputClass}`}
        />
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Find
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {customer && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">{customer.name}</div>
              <div className="text-sm text-slate-500">
                {customer.email} · {customer.phone}
              </div>
            </div>
            <div className="text-2xl font-bold text-teal-700">RM{customer.balance}</div>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
            <label className="flex flex-col text-xs font-medium text-slate-500">
              Top up (RM)
              <input
                type="number"
                min={1}
                max={MAX_TOP_UP}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`mt-1 w-28 ${inputClass}`}
              />
            </label>
            {[20, 50, 100].map((preset) => (
              <button
                key={preset}
                onClick={() => setAmount(String(preset))}
                className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-teal-500"
              >
                RM{preset}
              </button>
            ))}
            <button
              onClick={topUp}
              className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
            >
              Add credit
            </button>
          </div>

          {entries.length > 0 && (
            <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100 pt-2 text-sm">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-slate-600">{entry.reason}</span>
                  <span
                    className={`font-semibold ${
                      entry.amount >= 0 ? "text-emerald-700" : "text-slate-700"
                    }`}
                  >
                    {entry.amount >= 0 ? "+" : "−"}RM{Math.abs(entry.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>

      <PassesPanel venues={venues} />

      <MembershipsPanel venues={venues} />

      <PromosPanel venues={venues} />
    </div>
  );
}

/** Sell and manage multi-visit passes at the counter. */
function PassesPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [passes, setPasses] = useState<Pass[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "10-hour badminton pass",
    sport: "",
    entries: "10",
    price: "120",
    holderName: "",
    holderPhone: "",
    expiresOn: "",
  });

  const venue = venues.find((v) => v.id === venueId) ?? null;
  const sports = [...new Set((venue?.courts ?? []).map((c) => c.sport))];

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/passes?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setPasses(data.passes);
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          name: form.name,
          sport: form.sport || null,
          entries: Number(form.entries),
          price: Number(form.price),
          holderName: form.holderName,
          holderPhone: form.holderPhone,
          expiresOn: form.expiresOn,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not issue the pass");
      setNotice(`Sold ${data.pass.code} to ${data.pass.holderName}.`);
      setForm({ ...form, holderName: "", holderPhone: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not issue the pass");
    }
  }

  async function cancel(pass: Pass) {
    if (!confirm(`Cancel ${pass.code}? Entries already spent stay spent.`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/passes/${pass.id}/void`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not cancel the pass");
      setNotice(`Cancelled ${pass.code}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the pass");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">Multi-visit passes</h2>
      <p className="mt-1 text-sm text-slate-600">
        Sell a block of entries up front. One entry covers one booked hour, so a 2-hour booking
        spends two. The holder quotes the pass code when booking.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <form onSubmit={issue} className="mt-4 flex flex-wrap items-end gap-2">
        {venues.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Venue
            <select
              value={venueId}
              onChange={(e) => setVenueId(Number(e.target.value))}
              className={`mt-1 w-52 ${inputClass}`}
            >
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Pass name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`mt-1 w-56 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Sport
          <select
            value={form.sport}
            onChange={(e) => setForm({ ...form, sport: e.target.value })}
            className={`mt-1 w-40 ${inputClass}`}
          >
            <option value="">Any sport</option>
            {sports.map((sp) => (
              <option key={sp} value={sp}>
                {SPORT_ICONS[sp]} {SPORT_LABELS[sp]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Entries
          <input
            type="number"
            min={1}
            max={MAX_PASS_ENTRIES}
            required
            value={form.entries}
            onChange={(e) => setForm({ ...form, entries: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Price (RM)
          <input
            type="number"
            min={0}
            required
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Holder
          <input
            required
            placeholder="Name"
            value={form.holderName}
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
            className={`mt-1 w-40 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Phone
          <input
            required
            placeholder="0123456789"
            value={form.holderPhone}
            onChange={(e) => setForm({ ...form, holderPhone: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Expires
          <input
            type="date"
            required
            min={todayLocal()}
            value={form.expiresOn}
            onChange={(e) => setForm({ ...form, expiresOn: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Sell pass
        </button>
      </form>

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Pass</th>
              <th className="px-3 py-2">Holder</th>
              <th className="px-3 py-2">Left</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {passes.map((pass) => (
              <tr key={pass.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">
                  {pass.code}
                </td>
                <td className="px-3 py-2">
                  {pass.name}
                  <span className="ml-1 text-xs text-slate-400">
                    {pass.sport ? SPORT_ICONS[pass.sport] : "all sports"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {pass.holderName}
                  <span className="block text-xs text-slate-400">{pass.holderPhone}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="font-semibold">{pass.remaining}</span>
                  <span className="text-slate-400"> / {pass.entries}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">{pass.expiresOn}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {pass.unusableReason ? (
                    <span className="text-xs text-slate-400">{pass.unusableReason}</span>
                  ) : (
                    <button
                      onClick={() => cancel(pass)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {passes.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No passes sold at this venue yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Create and withdraw the venue's promo codes. */
function PromosPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [promos, setPromos] = useState<PromoCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    code: "",
    description: "",
    kind: "percent",
    value: "20",
    sport: "",
    minHours: "1",
    validFrom: todayLocal(),
    validTo: "",
    maxUses: "",
  });

  const venue = venues.find((v) => v.id === venueId) ?? null;
  const sports = [...new Set((venue?.courts ?? []).map((c) => c.sport))];

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/promos?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setPromos(data.promos);
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/promos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          code: form.code,
          description: form.description,
          kind: form.kind,
          value: Number(form.value),
          sport: form.sport || null,
          minHours: Number(form.minHours),
          validFrom: form.validFrom,
          validTo: form.validTo,
          maxUses: form.maxUses === "" ? null : Number(form.maxUses),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create the code");
      setNotice(`${data.promo.code} is live.`);
      setForm({ ...form, code: "", description: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the code");
    }
  }

  async function withdraw(promo: PromoCode) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/promos/${promo.id}/void`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not withdraw the code");
      setNotice(`${promo.code} withdrawn. Discounts already given stand.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not withdraw the code");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">Promo codes</h2>
      <p className="mt-1 text-sm text-slate-600">
        A discount customers claim by typing the code when they book. It comes off the booking
        total, so credit and passes then pay the discounted figure.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-2">
        {venues.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Venue
            <select
              value={venueId}
              onChange={(e) => setVenueId(Number(e.target.value))}
              className={`mt-1 w-52 ${inputClass}`}
            >
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Code
          <input
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            placeholder="RAYA20"
            className={`mt-1 w-32 font-mono ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          What it is for
          <input
            required
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="20% off for Raya"
            className={`mt-1 w-56 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Type
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
            className={`mt-1 w-28 ${inputClass}`}
          >
            <option value="percent">% off</option>
            <option value="amount">RM off</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {form.kind === "percent" ? "Percent" : "Ringgit"}
          <input
            type="number"
            min={1}
            max={form.kind === "percent" ? MAX_PROMO_PERCENT : MAX_PROMO_AMOUNT}
            required
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Sport
          <select
            value={form.sport}
            onChange={(e) => setForm({ ...form, sport: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          >
            <option value="">Any sport</option>
            {sports.map((sp) => (
              <option key={sp} value={sp}>
                {SPORT_ICONS[sp]} {SPORT_LABELS[sp]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Min hours
          <input
            type="number"
            min={1}
            max={MAX_HOURS_PER_BOOKING}
            value={form.minHours}
            onChange={(e) => setForm({ ...form, minHours: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          From
          <input
            type="date"
            required
            value={form.validFrom}
            onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Until
          <input
            type="date"
            required
            min={form.validFrom}
            value={form.validTo}
            onChange={(e) => setForm({ ...form, validTo: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Limit
          <input
            type="number"
            min={1}
            value={form.maxUses}
            onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
            placeholder="∞"
            title="Leave blank for unlimited"
            className={`mt-1 w-20 ${inputClass}`}
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Create code
        </button>
      </form>

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">What it is for</th>
              <th className="px-3 py-2">Takes off</th>
              <th className="px-3 py-2">Used</th>
              <th className="px-3 py-2">Runs</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {promos.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">
                  {p.code}
                </td>
                <td className="px-3 py-2">
                  {p.description}
                  <span className="ml-1 text-xs text-slate-400">
                    {p.sport ? SPORT_ICONS[p.sport] : "all sports"}
                    {p.minHours > 1 ? ` · ${p.minHours}h+` : ""}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-semibold">
                  {p.kind === "percent" ? `${p.value}%` : `RM${p.value}`}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {p.used}
                  <span className="text-slate-400"> / {p.maxUses ?? "∞"}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                  {p.validFrom} → {p.validTo}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {p.unusableReason ? (
                    <span className="text-xs text-slate-400">{p.unusableReason}</span>
                  ) : (
                    <button
                      onClick={() => withdraw(p)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Withdraw
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {promos.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No promo codes at this venue yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Sell and cancel memberships at the counter. */
function MembershipsPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [members, setMembers] = useState<Membership[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    holderName: "",
    holderPhone: "",
    startsOn: todayLocal(),
    expiresOn: "",
    price: "300",
  });

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/memberships?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setMembers(data.memberships);
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function sell(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/memberships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          holderName: form.holderName,
          holderPhone: form.holderPhone,
          startsOn: form.startsOn,
          expiresOn: form.expiresOn,
          price: Number(form.price),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not sell the membership");
      setNotice(`${data.membership.code} sold to ${data.membership.holderName}.`);
      setForm({ ...form, holderName: "", holderPhone: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sell the membership");
    }
  }

  async function cancel(m: Membership) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/memberships/${m.id}/void`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not cancel the membership");
      setNotice(`${m.code} cancelled. Bookings already made keep the price they were given.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the membership");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">Memberships</h2>
      <p className="mt-1 text-sm text-slate-600">
        A member pays your member rates, set per court under <strong>Courts &amp; rates</strong>.
        Membership is held against the phone number, so a member who books as a guest still gets
        their price.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <form onSubmit={sell} className="mt-4 flex flex-wrap items-end gap-2">
        {venues.length > 1 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Venue
            <select
              value={venueId}
              onChange={(e) => setVenueId(Number(e.target.value))}
              className={`mt-1 w-52 ${inputClass}`}
            >
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Member
          <input
            required
            placeholder="Name"
            value={form.holderName}
            onChange={(e) => setForm({ ...form, holderName: e.target.value })}
            className={`mt-1 w-44 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Phone
          <input
            required
            placeholder="0123456789"
            value={form.holderPhone}
            onChange={(e) => setForm({ ...form, holderPhone: e.target.value })}
            className={`mt-1 w-36 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          From
          <input
            type="date"
            required
            value={form.startsOn}
            onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Until
          <input
            type="date"
            required
            min={form.startsOn}
            value={form.expiresOn}
            onChange={(e) => setForm({ ...form, expiresOn: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Fee (RM)
          <input
            type="number"
            min={0}
            required
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            className={`mt-1 w-24 ${inputClass}`}
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
        >
          Sell membership
        </button>
      </form>

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[700px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Member</th>
              <th className="px-3 py-2">Runs</th>
              <th className="px-3 py-2">Fee</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">
                  {m.code}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {m.holderName}
                  <span className="block text-xs text-slate-400">{m.holderPhone}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                  {m.startsOn} → {m.expiresOn}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-semibold">RM{m.price}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {m.unusableReason ? (
                    <span className="text-xs text-slate-400">{m.unusableReason}</span>
                  ) : (
                    <button
                      onClick={() => cancel(m)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No members at this venue yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
