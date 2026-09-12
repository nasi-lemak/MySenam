"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { Court, SPORT_ICONS, Venue } from "@/lib/types";
import type { AdminBookingRow, AdminCourtSlots, OccupancyReport } from "@/lib/store";

type Tab = "bookings" | "schedule" | "occupancy" | "courts";

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
}

export default function AdminPage() {
  const [passcode, setPasscode] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("bookings");
  const [venues, setVenues] = useState<(Venue & { courts: Court[] })[]>([]);

  useEffect(() => {
    const saved = sessionStorage.getItem("mt-admin-passcode");
    if (saved) {
      setPasscode(saved);
      void tryUnlock(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function tryUnlock(code: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/bookings?date=${todayLocal()}`, {
        headers: { "x-admin-passcode": code },
        cache: "no-store",
      });
      if (res.status === 401) throw new Error("Wrong passcode.");
      if (!res.ok) throw new Error("Could not reach the server.");
      const venuesRes = await fetch("/api/venues", { cache: "no-store" });
      const venuesData = await venuesRes.json();
      setVenues(venuesData.venues);
      sessionStorage.setItem("mt-admin-passcode", code);
      setUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      sessionStorage.removeItem("mt-admin-passcode");
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <div className="mx-auto max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Admin</h1>
          <p className="mt-1 text-sm text-slate-600">Enter the admin passcode to continue.</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            tryUnlock(passcode);
          }}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <input
            type="password"
            required
            autoFocus
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Passcode"
            className="w-full rounded-md border border-slate-300 px-3 py-2 focus:border-teal-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Admin dashboard</h1>
        <button
          onClick={() => {
            sessionStorage.removeItem("mt-admin-passcode");
            setUnlocked(false);
            setPasscode("");
          }}
          className="text-sm text-slate-500 underline hover:text-teal-700"
        >
          Lock
        </button>
      </div>

      <div className="flex gap-2">
        {(
          [
            ["bookings", "Bookings"],
            ["schedule", "Court schedule"],
            ["occupancy", "Occupancy"],
            ["courts", "Courts & rates"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
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

      {tab === "bookings" && <BookingsTab passcode={passcode} />}
      {tab === "schedule" && <ScheduleTab passcode={passcode} venues={venues} />}
      {tab === "occupancy" && <OccupancyTab passcode={passcode} venues={venues} />}
      {tab === "courts" && (
        <CourtsTab passcode={passcode} venues={venues} onVenuesChange={setVenues} />
      )}
    </div>
  );
}

/* ---------------- Bookings tab ---------------- */

function BookingsTab({ passcode }: { passcode: string }) {
  const [date, setDate] = useState(todayLocal);
  const [bookings, setBookings] = useState<AdminBookingRow[] | null>(null);
  const [revenue, setRevenue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/bookings?date=${date}`, {
        headers: { "x-admin-passcode": passcode },
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setBookings(data.bookings);
      setRevenue(data.revenue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setBookings(null);
    } finally {
      setBusy(false);
    }
  }, [date, passcode]);

  useEffect(() => {
    load();
  }, [load]);

  async function cancelBooking(code: string) {
    if (!window.confirm(`Cancel booking ${code}? Its slots will be released.`)) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-passcode": passcode },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
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
              <span className="text-slate-500">Confirmed revenue:</span>{" "}
              <span className="font-bold text-teal-700">RM{revenue}</span>
            </div>
          </>
        )}
      </div>

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
                {["Code", "Venue", "Court", "Time", "Customer", "Phone", "Total", "Status", ""].map(
                  (h, i) => (
                    <th key={i} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-mono font-medium text-teal-700">{b.code}</td>
                  <td className="px-3 py-2">{b.venueName}</td>
                  <td className="px-3 py-2">
                    {SPORT_ICONS[b.sport]} {b.courtName}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {formatHour(b.startHour)} – {formatHour(b.endHour)}
                  </td>
                  <td className="px-3 py-2">{b.name}</td>
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
                    {b.status === "confirmed" && (
                      <button
                        onClick={() => cancelBooking(b.code)}
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
      ) : null}
    </div>
  );
}

/* ---------------- Court schedule tab ---------------- */

function ScheduleTab({
  passcode,
  venues,
}: {
  passcode: string;
  venues: (Venue & { courts: Court[] })[];
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [date, setDate] = useState(todayLocal);
  const [reason, setReason] = useState("");
  const [courts, setCourts] = useState<AdminCourtSlots[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/slots?venueId=${venueId}&date=${date}`, {
        headers: { "x-admin-passcode": passcode },
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setCourts(data.courts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setCourts(null);
    }
  }, [venueId, date, passcode]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(courtId: number, hour: number, status: string) {
    if (status !== "free" && status !== "blocked" && status !== "past") return;
    setError(null);
    try {
      const res = await fetch("/api/admin/blocks", {
        method: status === "blocked" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json", "x-admin-passcode": passcode },
        body: JSON.stringify({ courtId, date, hours: [hour], reason: reason || undefined }),
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
      </div>
      <p className="text-sm text-slate-500">
        Click a <span className="font-medium text-emerald-700">free</span> slot to block it for
        maintenance; click a <span className="font-medium text-amber-700">blocked</span> slot to
        release it. Booked slots show the booking code.
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
                  </td>
                  {slots.map((slot) => (
                    <td key={slot.hour} className="p-1 text-center">
                      <button
                        onClick={() => toggle(court.id, slot.hour, slot.status)}
                        disabled={slot.status === "booked"}
                        title={
                          slot.status === "booked"
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
                              : slot.status === "past"
                                ? "bg-slate-50 text-slate-300 hover:bg-slate-100"
                                : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        }`}
                      >
                        {slot.status === "booked"
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
  passcode,
  venues,
  onVenuesChange,
}: {
  passcode: string;
  venues: (Venue & { courts: Court[] })[];
  onVenuesChange: (venues: (Venue & { courts: Court[] })[]) => void;
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newCourt, setNewCourt] = useState({ name: "", sport: "badminton", offPeak: "", peak: "" });

  const venue = venues.find((v) => v.id === venueId);

  async function refreshVenues() {
    const res = await fetch("/api/venues", { cache: "no-store" });
    const data = await res.json();
    onVenuesChange(data.venues);
  }

  async function saveCourt(court: Court, name: string, offPeak: string, peak: string) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courts/${court.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-passcode": passcode },
        body: JSON.stringify({
          name,
          offPeakRate: Number(offPeak),
          peakRate: Number(peak),
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
        headers: { "Content-Type": "application/json", "x-admin-passcode": passcode },
        body: JSON.stringify({
          venueId,
          name: newCourt.name,
          sport: newCourt.sport,
          offPeakRate: Number(newCourt.offPeak),
          peakRate: Number(newCourt.peak),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not add court");
      setNotice(`Added ${data.court.name}.`);
      setNewCourt({ name: "", sport: newCourt.sport, offPeak: "", peak: "" });
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
                {["Court", "Sport", "Off-peak (RM/hr)", "Peak (RM/hr)", ""].map((h, i) => (
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
  onSave: (court: Court, name: string, offPeak: string, peak: string) => void;
}) {
  const [name, setName] = useState(court.name);
  const [offPeak, setOffPeak] = useState(String(court.offPeakRate));
  const [peak, setPeak] = useState(String(court.peakRate));
  const dirty =
    name !== court.name || offPeak !== String(court.offPeakRate) || peak !== String(court.peakRate);

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
        <button
          disabled={!dirty}
          onClick={() => onSave(court, name, offPeak, peak)}
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
  passcode,
  venues,
}: {
  passcode: string;
  venues: (Venue & { courts: Court[] })[];
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [report, setReport] = useState<OccupancyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/occupancy?venueId=${venueId}&days=7`, {
        headers: { "x-admin-passcode": passcode },
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setReport(null);
    }
  }, [venueId, passcode]);

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
                    const pct = Math.round((booked / report.totalSlotsPerDay) * 100);
                    return (
                      <td key={d.date} className="p-1 text-center">
                        <div
                          className={`rounded-md py-1.5 text-xs font-semibold ${heat(pct)}`}
                          title={`${booked}/${report.totalSlotsPerDay} hours booked${cell?.blocked ? `, ${cell.blocked} blocked` : ""}`}
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
                  const total = report.totalSlotsPerDay * report.courts.length;
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
