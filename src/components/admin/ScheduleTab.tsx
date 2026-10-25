"use client";

import { activityIcon } from "@/lib/activity-registry";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { RainOutPanel } from "./RainOutPanel";
import { RepeatBlockPanel } from "./RepeatBlockPanel";
import { formatHour } from "@/lib/time";
import { formatMinute } from "@/lib/interval";
import { ClockField } from "@/components/ClockField";
import { isShared } from "@/lib/types";
import type { Court, Venue } from "@/lib/types";
import type { AdminCourtSlots, ScheduleEntry } from "@/lib/store";
import type { StaffT } from "@/lib/staff-i18n";
import { todayLocal } from "./shared";
import { useStaffT } from "./StaffLanguage";

/** A phrase with elements in it: each `{name}` becomes the element given for it. */
function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 ? <Fragment key={i}>{parts[piece] ?? `{${piece}}`}</Fragment> : piece));
}

function kindLabels(t: StaffT): Record<ScheduleEntry["kind"], string> {
  return {
    booking: t("sch.kind.booking"),
    offer: t("sch.kind.offer"),
    move: t("sch.kind.move"),
    approval: t("apr.schKind"),
    class: t("sch.kind.class"),
    block: t("sch.kind.block"),
    outage: t("sch.kind.outage"),
    buffer: t("sch.kind.buffer"),
  };
}

/* ---------------- Court schedule tab ---------------- */

export function ScheduleTab({
  venues,
}: {
  venues: (Venue & { courts: Court[] })[];
}) {
  const t = useStaffT();
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
      if (!res.ok) throw new Error(t.err(data, t("sch.loadFailed")));
      setCourts(data.courts);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sch.loadFailed"));
      setCourts(null);
    }
  }, [venueId, date, t]);

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
      if (!res.ok) throw new Error(t.err(data, t("sch.updateFailed")));
      setExact(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sch.updateFailed"));
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
      if (!res.ok) throw new Error(t.err(data, t("sch.updateFailed")));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sch.updateFailed"));
    }
  }

  const kinds = kindLabels(t);
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
          placeholder={t("sch.reasonPlaceholder")}
          className="w-52 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          type="number"
          min={1}
          value={placesOut}
          onChange={(e) => setPlacesOut(e.target.value)}
          placeholder={t("sch.placesOut")}
          title={t("sch.placesOutTitle")}
          className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
      </div>
      <p className="text-sm text-slate-500">
        {rich(t("sch.help"), {
          free: <span className="font-medium text-emerald-700">{t("sch.helpFree")}</span>,
          blocked: <span className="font-medium text-amber-700">{t("sch.helpBlocked")}</span>,
          placesOut: <strong>{t("sch.helpPlacesOut")}</strong>,
        })}
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
              <ClockField label={t("sch.blockFrom")} value={exact.start} onChange={(m) => setExact({ ...exact, start: m })} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
              {t("sch.to")}
              <ClockField label={t("sch.blockUntil")} value={exact.end} after={exact.start} onChange={(m) => setExact({ ...exact, end: m })} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
              <button onClick={() => void blockExact()} className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
                {t("sch.blockIt")}
              </button>
              <button onClick={() => setExact(null)} className="text-xs text-slate-500 underline">
                {t("c.cancel")}
              </button>
            </>
          ) : (
            <button
              onClick={() => setExact({ courtId: courts[0].court.id, start: courts[0].slots[0]?.minute ?? 480, end: (courts[0].slots[0]?.minute ?? 480) + 60 })}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-amber-500"
            >
              {t("sch.blockExact")}
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
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-semibold">{t("sch.court")}</th>
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
                        {t.plural("sch.places", court.capacity)}
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
                            ? t("sch.taken", { booked: slot.booked, capacity: court.capacity }) +
                              (slot.blockedPlaces
                                ? ` · ${
                                    slot.blockReason
                                      ? t("sch.outOfServiceWhy", { n: slot.blockedPlaces, reason: slot.blockReason })
                                      : t("sch.outOfService", { n: slot.blockedPlaces })
                                  }`
                                : slot.status === "blocked"
                                  ? ` · ${slot.blockReason ? t("sch.allOutWhy", { reason: slot.blockReason }) : t("sch.allOut")}`
                                  : "")
                            : slot.status === "booked"
                              ? t("sch.booked", { code: String(slot.bookingCode) })
                              : slot.status === "blocked"
                                ? slot.blockReason
                                  ? t("sch.blockedWhyRelease", { reason: slot.blockReason })
                                  : t("sch.blockedRelease")
                                : slot.status === "past"
                                  ? t("sch.past")
                                  : t("sch.freeBlock")
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
          <h3 className="font-semibold">{t("sch.dayToMinute")}</h3>
          <p className="mt-1 text-xs text-slate-500">{t("sch.buffersHelp")}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {courts
              .filter((c) => c.entries.length > 0)
              .map(({ court, entries }) => (
                <div key={court.id}>
                  <div className="text-xs font-semibold text-slate-700">{court.name}</div>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {entries.map((e, i) => (
                      <li key={i} className={e.kind === "buffer" ? "text-slate-400" : "text-slate-700"}>
                        {formatMinute(e.start)}–{formatMinute(e.end)} · {t("sch.minutes", { n: e.end - e.start })} · {e.label || kinds[e.kind]}
                        {e.places ? ` · ${t.plural("sch.places", e.places)}` : ""}
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
