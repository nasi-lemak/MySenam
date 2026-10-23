"use client";

import { activityIcon } from "@/lib/activity-registry";
import { useCallback, useEffect, useState } from "react";
import { RainOutPanel } from "./RainOutPanel";
import { RepeatBlockPanel } from "./RepeatBlockPanel";
import { formatHour } from "@/lib/time";
import { formatMinute } from "@/lib/interval";
import { ClockField } from "@/components/ClockField";
import { isShared } from "@/lib/types";
import type { Court, Venue } from "@/lib/types";
import type { AdminCourtSlots } from "@/lib/store";
import { todayLocal } from "./shared";

/* ---------------- Court schedule tab ---------------- */

export function ScheduleTab({
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
  // Blocking an exact stretch of time, to the minute, rather than whole columns.
  const [exact, setExact] = useState<{ courtId: number; start: number; end: number } | null>(null);

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

  async function blockExact() {
    if (!exact) return;
    setError(null);
    const court = courts?.find((c) => c.court.id === exact.courtId)?.court;
    const places = placesOut.trim() !== "" && court && court.capacity > 1 ? Number(placesOut) : undefined;
    try {
      const res = await fetch("/api/admin/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courtId: exact.courtId, date, start: exact.start, end: exact.end, reason: reason || undefined, places }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      setExact(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

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
        the rest bookable. A slot marked ½ is partly held: the list under the grid has every booking, block and buffer
        to the minute.
      </p>
      {courts && courts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {exact ? (
            <>
              <select
                value={exact.courtId}
                onChange={(e) => setExact({ ...exact, courtId: Number(e.target.value) })}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {courts.map((c) => (
                  <option key={c.court.id} value={c.court.id}>
                    {c.court.name}
                  </option>
                ))}
              </select>
              <ClockField label="Block from" value={exact.start} onChange={(m) => setExact({ ...exact, start: m })} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
              to
              <ClockField label="Block until" value={exact.end} after={exact.start} onChange={(m) => setExact({ ...exact, end: m })} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
              <button onClick={() => void blockExact()} className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
                Block it
              </button>
              <button onClick={() => setExact(null)} className="text-xs text-slate-500 underline">
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setExact({ courtId: courts[0].court.id, start: courts[0].slots[0]?.minute ?? 480, end: (courts[0].slots[0]?.minute ?? 480) + 60 })}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-amber-500"
            >
              Block an exact time…
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {courts && courts.length > 0 && (
        <div className="flex flex-wrap items-start gap-2">
          <RainOutPanel
            venueId={venueId}
            date={date}
            courts={courts.map((c) => c.court)}
            hours={courts[0].slots.map((s) => s.hour)}
            onDone={() => void load()}
          />
          <RepeatBlockPanel
            venueId={venueId}
            date={date}
            courts={courts.map((c) => c.court)}
            hours={courts[0].slots.map((s) => s.hour)}
            onDone={() => void load()}
          />
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
                    {formatHour(s.hour).replace(":00 ", "").replace(" ", "")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {courts.map(({ court, slots }) => (
                <tr key={court.id} className="border-b border-slate-100 last:border-0">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-2 font-medium">
                    {activityIcon(court.sport)} {court.name}
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
                                : slot.partly
                                  ? "½"
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

      {courts && courts.some((c) => c.entries.length > 0) && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <h3 className="font-semibold">The day to the minute</h3>
          <p className="mt-1 text-xs text-slate-500">
            Buffers are time kept free around a booking (setup, cleaning); customers cannot book them and are not told why.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {courts
              .filter((c) => c.entries.length > 0)
              .map(({ court, entries }) => (
                <div key={court.id}>
                  <div className="text-xs font-semibold text-slate-700">{court.name}</div>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {entries.map((e, i) => (
                      <li key={i} className={e.kind === "buffer" ? "text-slate-400" : "text-slate-700"}>
                        {formatMinute(e.start)}–{formatMinute(e.end)} · {e.end - e.start} min · {e.label || e.kind}
                        {e.places ? ` · ${e.places} place${e.places === 1 ? "" : "s"}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
