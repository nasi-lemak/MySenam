"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import {
  ClassSession,
  Court,
  isShared,
  MAX_CAPACITY,
  MAX_CLASS_WEEKS,
  ACCESS_CODE_STALE_DAYS,
  MAX_ACCESS_CODE,
  MAX_EMERGENCY_INFO,
  MAX_DEPOSIT,
  MAX_HIRE_NOTE,
  HIRE_CONDITION_LABELS,
  HireCondition,
  MAX_TOP_UP,
  SPORT_ICONS,
  SPORT_LABELS,
  WalletEntry,
  MAX_PASS_ENTRIES,
  Induction,
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
import type { AccessReveal, AdminBookingRow, AdminCourtSlots, OccupancyReport } from "@/lib/store";
import type { VenueReport } from "@/lib/reports";

/** What one row of the courts table can change in a save. */
interface CourtEdits {
  name: string;
  offPeak: string;
  peak: string;
  capacity: string;
  memberOffPeak: string;
  memberPeak: string;
  deposit: string;
}

type Tab =
  | "bookings"
  | "schedule"
  | "occupancy"
  | "reports"
  | "courts"
  | "classes"
  | "credit"
  | "venues";

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
    ["reports", "Reports"],
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

      {isOwner && <FirstRun onSeeded={refreshVenues} />}

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
          {tab === "reports" && <ReportsTab venues={venues} />}
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
                  "Kit",
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
                    {b.hire === null && (b.courtDeposit === 0 || b.status !== "confirmed") ? (
                      <span className="text-xs text-slate-400">—</span>
                    ) : b.hire === null ? (
                      <button
                        onClick={() => openKit(b, "take")}
                        title={`Hand ${b.courtName} over against an RM${b.courtDeposit} deposit`}
                        className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
                      >
                        hand out
                      </button>
                    ) : b.hire.returnedAt === null ? (
                      <button
                        onClick={() => openKit(b, "return")}
                        title={`Out since ${localTime(b.hire.takenAt)}, RM${b.hire.deposit} held — click to take it back`}
                        className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-200"
                      >
                        out · RM{b.hire.deposit}
                      </button>
                    ) : (
                      <span
                        title={
                          (b.hire.note ?? "No note.") +
                          (b.hire.withheld ? ` RM${b.hire.withheld} kept back.` : "")
                        }
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          b.hire.condition === "ok"
                            ? "bg-slate-100 text-slate-500"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {b.hire.condition === "ok"
                          ? "back"
                          : `${HIRE_CONDITION_LABELS[b.hire.condition!].toLowerCase()}${
                              b.hire.withheld ? ` · RM${b.hire.withheld}` : ""
                            }`}
                      </span>
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

/* ---------------- Reports tab ---------------- */

/** First day of the month `back` months before this one, as YYYY-MM-DD. */
function monthStart(back: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return d.toISOString().slice(0, 10);
}

/** Today, less `back` days, as YYYY-MM-DD. */
function daysAgo(back: number): string {
  const d = new Date(`${todayLocal()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * The first range is the default, and it is 30 days rather than a calendar
 * quarter on purpose: a quarter that is two-thirds empty averages a good month
 * down to nothing, which reads as "this venue is dead" on the first screen
 * anybody opens.
 */
const RANGES: [string, () => { from: string; to: string }][] = [
  ["Last 30 days", () => ({ from: daysAgo(29), to: todayLocal() })],
  ["This month", () => ({ from: monthStart(0), to: todayLocal() })],
  ["Last 3 months", () => ({ from: monthStart(2), to: todayLocal() })],
];

const ringgit = (n: number) => `RM${n.toLocaleString("en-MY")}`;

/**
 * A venue at 0.4% and a venue at 0% are not the same venue, and rounding both
 * to "0%" hides the only thing the number is for.
 */
function percent(fraction: number): string {
  const value = fraction * 100;
  if (value === 0) return "0%";
  if (value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

/**
 * What the owner asks at the end of a month.
 *
 * Two colours do all the work and they mean one thing each: teal is money in
 * hand, amber is money still owed. Both are direct-labelled and carry a legend,
 * so nothing here is readable only by colour.
 */
function ReportsTab({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [range, setRange] = useState(() => RANGES[0][1]());
  const [data, setData] = useState<{
    report: VenueReport;
    wallet: { customers: number; balance: number } | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/reports?venueId=${venueId}&from=${range.from}&to=${range.to}`,
        { cache: "no-store" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not build the report");
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the report");
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [venueId, range]);

  useEffect(() => {
    load();
  }, [load]);

  const report = data?.report;
  const peakHour = report
    ? report.byHour.reduce((best, h) => (h.hours > best.hours ? h : best), report.byHour[0])
    : null;
  const monthPeak = report ? Math.max(1, ...report.byMonth.map((m) => m.expected)) : 1;
  const hourPeak = report ? Math.max(1, ...report.byHour.map((h) => h.hours)) : 1;

  return (
    <div className="space-y-5">
      {/* Filters, one row, above everything they change. */}
      <div className="flex flex-wrap items-end gap-2">
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
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          type="date"
          value={range.to}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        {RANGES.map(([label, make]) => (
          <button
            key={label}
            onClick={() => setRange(make())}
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {busy && !report ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          Working it out…
        </div>
      ) : report ? (
        <>
          {/* The four numbers the month is judged on. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Collected
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-teal-700">
                {ringgit(report.revenue.collected)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                of {ringgit(report.revenue.expected)} booked
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Still owed
              </div>
              <div
                className={`mt-1 text-3xl font-bold tracking-tight ${
                  report.revenue.outstanding > 0 ? "text-amber-700" : "text-slate-400"
                }`}
              >
                {ringgit(report.revenue.outstanding)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                across {report.bookings.confirmed} bookings
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                How full
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">
                {percent(report.utilisation.courts.percent)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                courts —{" "}
                {report.utilisation.courts.soldHours.toLocaleString("en-MY")} of{" "}
                {report.utilisation.courts.sellableHours.toLocaleString("en-MY")} hours
              </div>
              {report.utilisation.shared.sellableHours > 0 && (
                <div className="mt-1 text-xs text-slate-500">
                  <span className="font-semibold text-slate-700">
                    {percent(report.utilisation.shared.percent)}
                  </span>{" "}
                  of the shared floors and pools
                </div>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Cancelled &amp; no-shows
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">
                {report.bookings.cancelled + report.bookings.noShows}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {report.bookings.cancelled} cancelled · {report.bookings.noShows} never turned up
              </div>
            </div>
          </div>

          {/* Money by month. Only earns a chart once there is more than one. */}
          {report.byMonth.length > 1 && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">Taken by month</h3>
                <div className="flex items-center gap-3 text-xs text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-teal-600" /> Collected
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-amber-600" /> Still owed
                  </span>
                </div>
              </div>

              <div className="mt-4 flex items-end gap-3 overflow-x-auto pb-1">
                {report.byMonth.map((m) => {
                  const owed = m.expected - m.collected;
                  const height = (v: number) => Math.round((v / monthPeak) * 132);
                  return (
                    <div key={m.month} className="flex w-16 shrink-0 flex-col items-center">
                      <div className="text-xs font-semibold text-slate-700">
                        {m.expected > 0 ? ringgit(m.expected) : "—"}
                      </div>
                      <div
                        className="mt-1 flex w-full flex-col justify-end"
                        style={{ height: 140 }}
                        title={`${m.month}: ${ringgit(m.collected)} collected, ${ringgit(owed)} owed, ${m.hours} hours`}
                      >
                        {owed > 0 && (
                          <div
                            className="w-full rounded-t bg-amber-600"
                            style={{ height: Math.max(3, height(owed)) }}
                          />
                        )}
                        {m.collected > 0 && (
                          <div
                            className={`w-full bg-teal-600 ${owed > 0 ? "mt-0.5 rounded-b" : "rounded"}`}
                            style={{ height: Math.max(3, height(m.collected)) }}
                          />
                        )}
                        {m.expected === 0 && (
                          <div className="w-full rounded-sm bg-slate-100" style={{ height: 3 }} />
                        )}
                      </div>
                      <div className="mt-1.5 text-xs text-slate-500">{m.month.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* When the place is actually busy. One hue; the peak is the point. */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold">Hours sold, by time of day</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Where peak really is — worth checking your peak rate against.
              </p>
              <div className="mt-4 flex h-32 items-end gap-0.5">
                {report.byHour.map((h) => (
                  <div
                    key={h.hour}
                    className="group relative flex flex-1 flex-col justify-end"
                    style={{ height: "100%" }}
                    title={`${formatHour(h.hour)} — ${h.hours} hours sold`}
                  >
                    <div
                      className={`w-full rounded-t ${
                        peakHour && h.hour === peakHour.hour && h.hours > 0
                          ? "bg-teal-700"
                          : "bg-teal-600"
                      } ${h.hours === 0 ? "bg-slate-100" : ""}`}
                      style={{
                        height: `${h.hours === 0 ? 2 : Math.max(4, (h.hours / hourPeak) * 100)}%`,
                      }}
                    />
                    <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-white group-hover:block">
                      {h.hours}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex justify-between text-xs text-slate-500">
                <span>{formatHour(report.byHour[0]?.hour ?? 0)}</span>
                {peakHour && peakHour.hours > 0 && (
                  <span className="font-medium text-teal-700">
                    busiest {formatHour(peakHour.hour)} · {peakHour.hours} hrs
                  </span>
                )}
                <span>{formatHour(report.byHour[report.byHour.length - 1]?.hour ?? 0)}</span>
              </div>
            </div>

            {/* What the venue still owes people. Numbers, not a chart. */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold">What you still owe</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Sold and not yet used. These are hours and visits people can still come and take.
              </p>
              <dl className="mt-3 space-y-2 text-sm">
                {[
                  [
                    "Unspent pass entries",
                    `${report.liabilities.passEntriesUnspent} hours`,
                    `across ${report.liabilities.passesLive} live passes`,
                  ],
                  [
                    "Memberships running",
                    `${report.liabilities.membershipsActive}`,
                    `${report.liabilities.membershipsExpiringSoon} lapse within a month`,
                  ],
                  ...(data?.wallet
                    ? ([
                        [
                          "Stored credit (all venues)",
                          ringgit(data.wallet.balance),
                          `held by ${data.wallet.customers} customers`,
                        ],
                      ] as [string, string, string][])
                    : ([] as [string, string, string][])),
                ].map(([label, value, note]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-2 last:border-0"
                  >
                    <div>
                      <dt className="font-medium text-slate-700">{label}</dt>
                      <dd className="text-xs text-slate-500">{note}</dd>
                    </div>
                    <div className="shrink-0 font-semibold text-slate-900">{value}</div>
                  </div>
                ))}
              </dl>
              {report.closedDays > 0 && (
                <p className="mt-3 text-xs text-slate-500">
                  {report.closedDays === 1
                    ? "1 closed day in this period is"
                    : `${report.closedDays} closed days in this period are`}{" "}
                  left out of the sellable hours.
                </p>
              )}
            </div>
          </div>

          {/* Per court: a ratio against a limit, so a meter each. */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold">How hard each court worked</h3>
            <div className="mt-3 space-y-2.5">
              {report.byCourt.map((c) => (
                <div key={c.courtId} className="flex flex-wrap items-center gap-3 text-sm">
                  <div className="w-44 shrink-0">
                    {SPORT_ICONS[c.sport]} {c.courtName}
                  </div>
                  <div
                    className="h-3 min-w-[8rem] flex-1 overflow-hidden rounded-full bg-slate-100"
                    title={`${c.hours} of ${c.sellableHours} sellable hours`}
                  >
                    <div
                      className="h-full rounded-full bg-teal-600"
                      style={{
                        width:
                          c.hours === 0
                            ? 0
                            : `max(3px, ${Math.min(100, c.utilisation * 100)}%)`,
                      }}
                    />
                  </div>
                  <div className="w-14 shrink-0 text-right font-semibold tabular-nums">
                    {percent(c.utilisation)}
                  </div>
                  <div className="w-24 shrink-0 text-right text-slate-500 tabular-nums">
                    {ringgit(c.expected)}
                  </div>
                </div>
              ))}
              {report.byCourt.length === 0 && (
                <p className="text-sm text-slate-500">This venue has no courts yet.</p>
              )}
            </div>
          </div>

          {/* More than a couple of measures per row: a table, not more colours. */}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  {["Sport", "Bookings", "Hours", "Booked", "Collected"].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.bySport.map((s) => (
                  <tr key={s.sport} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      {SPORT_ICONS[s.sport]} {SPORT_LABELS[s.sport]}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{s.bookings}</td>
                    <td className="px-3 py-2 tabular-nums">{s.hours}</td>
                    <td className="px-3 py-2 tabular-nums">{ringgit(s.expected)}</td>
                    <td className="px-3 py-2 font-medium tabular-nums text-teal-700">
                      {ringgit(s.collected)}
                    </td>
                  </tr>
                ))}
                {report.bySport.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                      Nothing was booked at {report.venueName} between {report.from} and{" "}
                      {report.to}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
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
  // The door being looked at. The code is fetched only when staff ask for it,
  // so it is not sitting on a counter screen all shift.
  const [door, setDoor] = useState<{
    court: Court;
    code: string;
    changedAt: string | null;
    stale: boolean;
    unmanned: boolean;
  } | null>(null);
  const [reveals, setReveals] = useState<AccessReveal[] | null>(null);
  const [newCourt, setNewCourt] = useState({
    name: "",
    sport: "badminton",
    offPeak: "",
    peak: "",
    capacity: "1",
    deposit: "0",
  });

  const venue = venues.find((v) => v.id === venueId);

  async function refreshVenues() {
    const res = await fetch("/api/venues", { cache: "no-store" });
    const data = await res.json();
    onVenuesChange(data.venues);
  }

  async function saveCourt(court: Court, edits: CourtEdits) {
    const { name, offPeak, peak, capacity, memberOffPeak, memberPeak, deposit } = edits;
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
          deposit: Number(deposit),
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

  /** Open the door panel for a court, fetching its current code. */
  async function openDoor(court: Court) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${court.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the door");
      setDoor({
        court,
        code: data.access.code ?? "",
        changedAt: data.access.changedAt,
        stale: data.access.stale,
        unmanned: data.court.unmanned,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the door");
    }
  }

  /**
   * Save what staff have programmed into the lock. MySenam only relays the
   * code, so this never invents one: a code the lock has not been told about
   * would shut out the one person entitled to be there.
   */
  async function saveDoor(changes: { unmanned?: boolean; accessCode?: string | null }) {
    if (!door) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${door.court.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the door");
      setDoor({
        court: data.court,
        code: data.access.code ?? "",
        changedAt: data.access.changedAt,
        stale: data.access.stale,
        unmanned: data.court.unmanned,
      });
      setNotice(
        data.court.unmanned
          ? `${data.court.name} is unmanned — customers with a paid booking see the code an hour before their slot.`
          : `${data.court.name} is staffed. No code is given out for it.`
      );
      refreshVenues();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the door");
    }
  }

  /** Who has been let in, on demand rather than on every page load. */
  async function loadReveals() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/access?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the door log");
      setReveals(data.reveals);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the door log");
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
          deposit: Number(newCourt.deposit),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not add court");
      setNotice(`Added ${data.court.name}.`);
      setNewCourt({
        name: "",
        sport: newCourt.sport,
        offPeak: "",
        peak: "",
        capacity: "1",
        deposit: "0",
      });
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
                  "Member off-peak", "Member peak", "Capacity", "Deposit (RM)", "Door", "",
                ].map((h, i) => (
                  <th key={i} className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {venue.courts.map((court) => (
                <CourtRow
                  key={court.id}
                  court={court}
                  onSave={saveCourt}
                  onDoor={() => openDoor(court)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {door && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">The door on {door.court.name}</p>
            <button
              onClick={() => setDoor(null)}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Close
            </button>
          </div>
          <p className="mt-0.5 text-xs text-slate-600">
            Type in the code you have programmed into the lock. MySenam only passes it on — it
            never changes the lock, so a code invented here would shut everybody out.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600">Code on the lock</label>
              <input
                value={door.code}
                onChange={(e) => setDoor({ ...door, code: e.target.value })}
                maxLength={MAX_ACCESS_CODE}
                placeholder="4821"
                className="mt-1 w-32 rounded-md border border-slate-300 px-2 py-1 font-mono text-sm tracking-widest focus:border-teal-500 focus:outline-none"
              />
            </div>
            <button
              onClick={() => saveDoor({ accessCode: door.code })}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
            >
              Save code
            </button>
            <button
              onClick={() => saveDoor({ unmanned: !door.unmanned })}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                door.unmanned
                  ? "border border-slate-300 text-slate-600 hover:bg-slate-50"
                  : "bg-teal-600 text-white hover:bg-teal-700"
              }`}
            >
              {door.unmanned ? "Put someone on this door" : "Leave this one unmanned"}
            </button>
            {door.code !== "" && (
              <button
                onClick={() => saveDoor({ accessCode: null })}
                title="Forget the code. The resource stops being unmanned."
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600"
              >
                Clear
              </button>
            )}
          </div>

          <p className="mt-2 text-xs text-slate-600">
            {door.unmanned
              ? "Unmanned. A customer with a paid booking sees this code an hour before their slot, and that counts as their arrival."
              : "Staffed. Nobody is given a code for this one."}
            {door.changedAt && ` Code last changed ${localTime(door.changedAt)}.`}
          </p>
          {door.stale && (
            <p className="mt-1 text-xs font-medium text-red-700">
              This code has not changed in over {ACCESS_CODE_STALE_DAYS} days. Change it on the
              lock, then type the new one in here.
            </p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Who has been let in</p>
            <p className="text-xs text-slate-500">
              Every time a door code was shown, newest first. This is the list you want when a
              court is found in a state.
            </p>
          </div>
          <button
            onClick={() => (reveals === null ? loadReveals() : setReveals(null))}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
          >
            {reveals === null ? "Show log" : "Hide"}
          </button>
        </div>
        {reveals !== null &&
          (reveals.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              Nobody has been given a code at this venue yet.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[460px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    {["When", "Code", "Court", "Customer", "Phone"].map((h) => (
                      <th key={h} className="px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reveals.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="whitespace-nowrap px-3 py-2">{localTime(r.revealedAt)}</td>
                      <td className="px-3 py-2 font-mono text-teal-700">{r.bookingCode}</td>
                      <td className="px-3 py-2">{r.courtName}</td>
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.phone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>

      <InductionsPanel venueId={venueId} />

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
        <input
          type="number"
          min={0}
          max={MAX_DEPOSIT}
          value={newCourt.deposit}
          onChange={(e) => setNewCourt({ ...newCourt, deposit: e.target.value })}
          title="Deposit held while the kit is out. 0 for anything that stays on site."
          placeholder="Deposit"
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
  onDoor,
}: {
  court: Court;
  onSave: (court: Court, edits: CourtEdits) => void;
  onDoor: () => void;
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
  const [deposit, setDeposit] = useState(String(court.deposit));
  const asText = (v: number | null) => (v === null ? "" : String(v));
  const dirty =
    name !== court.name ||
    offPeak !== String(court.offPeakRate) ||
    peak !== String(court.peakRate) ||
    capacity !== String(court.capacity) ||
    memberOffPeak !== asText(court.memberOffPeakRate) ||
    memberPeak !== asText(court.memberPeakRate) ||
    deposit !== String(court.deposit);

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
        <input
          type="number"
          min={0}
          max={MAX_DEPOSIT}
          value={deposit}
          onChange={(e) => setDeposit(e.target.value)}
          title="Held at the desk while the kit is out. 0 for anything that stays put, like a court."
          className="w-20 rounded-md border border-slate-200 px-2 py-1 focus:border-teal-500 focus:outline-none"
        />
      </td>
      <td className="px-3 py-2">
        <button
          onClick={onDoor}
          title="The code on this door, and who has been given it"
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${
            court.unmanned
              ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
          }`}
        >
          {court.unmanned ? "unmanned" : "staffed"}
        </button>
      </td>
      <td className="px-3 py-2">
        <button
          disabled={!dirty}
          onClick={() =>
            onSave(court, { name, offPeak, peak, capacity, memberOffPeak, memberPeak, deposit })
          }
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

      {isOwner && <BackupsPanel />}

      {isOwner && <RetentionPanel />}

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
    staffedFrom: venue.staffedFrom,
    staffedTo: venue.staffedTo,
    emergencyPhone: venue.emergencyPhone ?? "",
    emergencyInfo: venue.emergencyInfo ?? "",
  });
  const dirty =
    fields.name !== venue.name ||
    fields.area !== venue.area ||
    fields.address !== venue.address ||
    fields.phone !== venue.phone ||
    fields.cancelCutoffHours !== venue.cancelCutoffHours ||
    fields.openHour !== venue.openHour ||
    fields.closeHour !== venue.closeHour ||
    fields.staffedFrom !== venue.staffedFrom ||
    fields.staffedTo !== venue.staffedTo ||
    fields.emergencyPhone !== (venue.emergencyPhone ?? "") ||
    fields.emergencyInfo !== (venue.emergencyInfo ?? "");

  // null on both ends is the default and means somebody is always here.
  const alwaysStaffed = fields.staffedFrom === null || fields.staffedTo === null;
  const neverStaffed = !alwaysStaffed && fields.staffedFrom === fields.staffedTo;

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
      <div className="w-full border-t border-slate-100 pt-3">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <p className="text-xs font-semibold text-slate-700">Somebody on the counter</p>
            <p className="text-xs text-slate-500">
              Outside these hours the venue runs itself: only resources you have marked unmanned
              can be used, and only by people you have inducted.
            </p>
          </div>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            From
            <select
              value={fields.staffedFrom ?? ""}
              onChange={(e) =>
                setFields({
                  ...fields,
                  staffedFrom: e.target.value === "" ? null : Number(e.target.value),
                  staffedTo: e.target.value === "" ? null : (fields.staffedTo ?? fields.closeHour),
                })
              }
              className={`mt-1 w-28 ${inputClass}`}
            >
              <option value="">Always</option>
              {HOUR_CHOICES.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            To
            <select
              value={fields.staffedTo ?? ""}
              disabled={fields.staffedFrom === null}
              onChange={(e) =>
                setFields({
                  ...fields,
                  staffedTo: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className={`mt-1 w-28 ${inputClass} disabled:bg-slate-50`}
            >
              <option value="">Always</option>
              {HOUR_CHOICES.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-1.5 text-xs font-medium text-slate-500">
            {alwaysStaffed
              ? "Somebody is here whenever you are open."
              : neverStaffed
                ? "Nobody is ever on the counter here."
                : `Unstaffed outside ${formatHour(fields.staffedFrom!)}–${formatHour(fields.staffedTo!)}.`}
          </span>
        </div>

        {!alwaysStaffed && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs font-medium text-slate-500">
              Emergency number
              <input
                value={fields.emergencyPhone}
                onChange={(e) => setFields({ ...fields, emergencyPhone: e.target.value })}
                placeholder="+60 12-345 6789"
                title="Shown to anybody letting themselves in. A number that is answered at 2 AM."
                className={`mt-1 w-40 ${inputClass}`}
              />
            </label>
            <label className="flex flex-1 flex-col text-xs font-medium text-slate-500">
              What to tell them
              <input
                value={fields.emergencyInfo}
                maxLength={MAX_EMERGENCY_INFO}
                onChange={(e) => setFields({ ...fields, emergencyInfo: e.target.value })}
                placeholder="AED on the wall by the main door. Nearest clinic: Klinik Kesihatan SS2, 5 min."
                className={`mt-1 w-full min-w-[16rem] ${inputClass}`}
              />
            </label>
          </div>
        )}
      </div>

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

/**
 * Who may use this venue when nobody is on the counter.
 *
 * The induction is the thing that makes unstaffed hours defensible rather than
 * reckless: somebody was shown the emergency button, the rules and the way out,
 * in person, by a named member of staff. So it is recorded here and never by
 * the customer.
 */
function InductionsPanel({ venueId }: { venueId: number }) {
  const [inductions, setInductions] = useState<Induction[] | null>(null);
  const [form, setForm] = useState({ phone: "", name: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/inductions?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load inductions");
      setInductions(data.inductions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load inductions");
      setInductions(null);
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/inductions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not record the induction");
      setNotice(`${data.induction.name} can now use this venue out of hours.`);
      setForm({ phone: "", name: "", note: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the induction");
    }
  }

  async function revoke(induction: Induction) {
    if (!window.confirm(`Withdraw out-of-hours access for ${induction.name}?`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/inductions/${induction.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not withdraw access");
      setNotice(`${induction.name} can no longer get in out of hours.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not withdraw access");
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-sm font-semibold">Cleared for unstaffed hours</p>
      <p className="text-xs text-slate-500">
        Record this after you have walked somebody round in person: the emergency button, the
        rules, and their IC. Nobody gets a door code out of hours without it.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
        <input
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Name"
          className="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          required
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="012-345 6789"
          className="w-36 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          placeholder="IC checked, shown the alarm"
          className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
        >
          Record induction
        </button>
      </form>

      {inductions !== null &&
        (inductions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            Nobody is cleared for unstaffed hours here yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  {["Name", "Phone", "Inducted", "By", "Note", ""].map((h, i) => (
                    <th key={i} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inductions.map((i) => (
                  <tr
                    key={i.id}
                    className={`border-b border-slate-100 last:border-0 ${
                      i.revokedAt ? "text-slate-400" : ""
                    }`}
                  >
                    <td className="px-3 py-2 font-medium">{i.name}</td>
                    <td className="whitespace-nowrap px-3 py-2">{i.phone}</td>
                    <td className="whitespace-nowrap px-3 py-2">{localTime(i.createdAt)}</td>
                    <td className="px-3 py-2">{i.adminName ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-500">{i.note ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      {i.revokedAt ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold">
                          withdrawn
                        </span>
                      ) : (
                        <button
                          onClick={() => revoke(i)}
                          className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                        >
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

/**
 * Backups, where the person responsible can see them.
 *
 * The schedule does the work; this exists so that "are we backed up?" has an
 * answer that is not "ssh in and look", and so somebody can take one by hand
 * before doing something they are not sure about.
 */
function BackupsPanel() {
  const [state, setState] = useState<{
    backups: { name: string; bytes: number; takenAt: string }[];
    directory: string;
    database: string;
    hoursSinceLast: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/backup", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read the backups");
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the backups");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function takeOne() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/backup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Backup failed");
      setNotice(
        `${data.file.name} — ${Math.round(data.file.bytes / 1024)} KB, ${data.bookings} bookings.` +
          (data.pruned.length > 0 ? ` Retired ${data.pruned.length} older.` : "")
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setBusy(false);
    }
  }

  const stale = state !== null && (state.hoursSinceLast === null || state.hoursSinceLast > 48);

  return (
    <section>
      <h2 className="text-lg font-bold">Backups</h2>
      <p className="mt-1 text-sm text-slate-500">
        Everything every venue has is one file. These are the copies of it.
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

      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            {state === null ? (
              <span className="text-slate-500">Loading…</span>
            ) : state.hoursSinceLast === null ? (
              <span className="font-semibold text-red-700">
                No backup has ever been taken.
              </span>
            ) : (
              <span className={stale ? "font-semibold text-red-700" : "text-slate-700"}>
                Newest backup {Math.round(state.hoursSinceLast)} hours old
                {stale && " — check the schedule is running"}
              </span>
            )}
          </div>
          <button
            onClick={takeOne}
            disabled={busy}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Taking…" : "Back up now"}
          </button>
        </div>

        {state !== null && (
          <>
            <p className="mt-2 text-xs text-slate-500">
              <span className="font-mono">{state.database}</span> →{" "}
              <span className="font-mono">{state.directory}</span>
            </p>
            {state.backups.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                Nothing here yet. Schedule <span className="font-mono">npm run backup</span> daily,
                and keep a copy somewhere that is not this machine.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      {["Taken", "File", "Size"].map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {state.backups.map((b) => (
                      <tr key={b.name} className="border-b border-slate-100 last:border-0">
                        <td className="whitespace-nowrap px-3 py-2">{b.takenAt}</td>
                        <td className="px-3 py-2 font-mono text-xs">{b.name}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {Math.round(b.bytes / 1024)} KB
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Housekeeping, where the person answerable for it can see it.
 *
 * Keeping a customer's phone number for ever is a decision, whether or not
 * anybody made it on purpose. This shows what the policy is, what it is about
 * to remove, and when it last ran.
 */
function RetentionPanel() {
  const [state, setState] = useState<{
    due: { what: string; days: number; action: string; affected: number }[];
    lastRun: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/retention", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read the retention policy");
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the retention policy");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runNow() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/retention", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Housekeeping failed");
      setNotice(
        data.total === 0
          ? "Nothing was old enough to remove."
          : `${data.total} records removed or anonymised.`
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Housekeeping failed");
    } finally {
      setBusy(false);
    }
  }

  const due = state?.due.reduce((n, l) => n + l.affected, 0) ?? 0;

  return (
    <section>
      <h2 className="text-lg font-bold">Keeping nothing too long</h2>
      <p className="mt-1 text-sm text-slate-500">
        Personal details are removed once they stop being useful. This runs by itself the first
        time anyone opens the dashboard each day.
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

      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-700">
            {state === null
              ? "Loading…"
              : due === 0
                ? "Nothing is currently past its date."
                : `${due} records are past their date.`}
            {state?.lastRun && (
              <span className="text-slate-500"> Last run {localTime(state.lastRun)}.</span>
            )}
          </div>
          <button
            onClick={runNow}
            disabled={busy}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Running…" : "Run now"}
          </button>
        </div>

        {state !== null && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[440px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  {["What", "Kept for", "Then", "Due"].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.due.map((line) => (
                  <tr key={line.what} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{line.what}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {line.days === 0 ? "until they expire" : `${line.days} days`}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{line.action}</td>
                    <td className="px-3 py-2 font-medium tabular-nums">
                      {line.affected === 0 ? "—" : line.affected}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs text-slate-500">
          A booking is never deleted — its hour and its price are your accounting record. It stops
          naming anybody instead.
        </p>
      </div>
    </section>
  );
}

/* ---------------- First run ---------------- */

/**
 * What an empty install says for itself.
 *
 * A fresh MySenam has venues and courts and nothing else, so every tab opens
 * blank and a newcomer has no idea which of the eight to start with. This
 * appears only while nothing has been sold — the moment a real booking exists
 * it is gone for good, which is also what stops demo customers ever appearing
 * in a working venue's day list.
 */
function FirstRun({ onSeeded }: { onSeeded: () => void }) {
  const [empty, setEmpty] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ bookings: number; extras: string[] } | null>(null);

  useEffect(() => {
    fetch("/api/admin/demo", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { empty: false }))
      .then((d) => setEmpty(d.empty === true))
      .catch(() => setEmpty(false));
  }, []);

  async function loadDemo() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/demo", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the demo data");
      setDone({ bookings: data.bookings, extras: data.extras });
      setEmpty(false);
      onSeeded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the demo data");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-900">
          {done.bookings} bookings written across the last two weeks and the next two.
        </p>
        <p className="mt-1 text-sm text-emerald-800">
          Plus {done.extras.join(", ")}. Every tab has something in it now — start with{" "}
          <strong>Reports</strong> to see a month, or <strong>Bookings</strong> for today&apos;s desk.
        </p>
      </div>
    );

  if (empty !== true) return null;

  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-4">
      <h2 className="text-base font-bold text-teal-900">Nothing has been booked here yet</h2>
      <p className="mt-1 max-w-2xl text-sm text-teal-900/80">
        Every tab will look empty until somebody books something. Two ways forward, depending on
        why you are here.
      </p>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-teal-200 bg-white p-3.5">
          <p className="text-sm font-semibold">Just looking?</p>
          <p className="mt-1 text-sm text-slate-600">
            Fill this install with a plausible fortnight — bookings across every sport, a class
            with a roster, passes, a membership, a promo code, arrivals and a no-show. Enough to
            see what each screen is for.
          </p>
          <button
            onClick={loadDemo}
            disabled={busy}
            className="mt-3 rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Writing…" : "Load demo data"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Offered only while this install is empty. Once a real booking exists it is refused, so
            invented customers cannot appear in a working day list.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <p className="text-sm font-semibold">Setting up a real venue?</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>
              <strong>Venues &amp; staff</strong> — add your venue, its opening hours and its
              cancellation cutoff.
            </li>
            <li>
              <strong>Courts &amp; rates</strong> — add each court with its peak and off-peak
              price. A gym floor or pool takes a capacity above 1.
            </li>
            <li>
              <strong>Venues &amp; staff</strong> again — create a login for whoever works the
              counter, and change the password you signed in with.
            </li>
          </ol>
          <p className="mt-2 text-xs text-slate-500">
            The four demo venues that ship with MySenam can stay or go — they are only there so the
            first screen is not blank.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
