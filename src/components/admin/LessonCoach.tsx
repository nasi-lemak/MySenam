"use client";

import { useEffect, useState } from "react";
import type { Coach } from "@/lib/coaching";
import { useStaffT } from "./StaffLanguage";

/**
 * Which coach a lesson being moved goes with (`POST
 * /api/admin/bookings/reschedule`, `coachId`): its own, or another active
 * coach of the venue for its sport. The times offered follow the coach
 * chosen; the server refuses another coach once anything is paid.
 */
export function LessonCoach({
  venueId,
  sport,
  coachId,
  coachName,
  value,
  onChange,
}: {
  venueId: number;
  sport: string;
  /** The coach on the lesson now. */
  coachId: number;
  coachName: string;
  value: number;
  onChange: (coachId: number) => void;
}) {
  const t = useStaffT();
  const [coaches, setCoaches] = useState<Coach[]>([]);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/coaches?venueId=${venueId}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { coaches?: Coach[] } | null) => live && setCoaches(data?.coaches ?? []))
      .catch(() => live && setCoaches([]));
    return () => {
      live = false;
    };
  }, [venueId]);

  const others = coaches.filter((c) => c.active && c.id !== coachId && c.sports.includes(sport));
  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">{t("fin6.bk.coach")}</span>
        <select
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        >
          <option value={coachId}>{t("fin6.bk.coachAsBooked", { name: coachName })}</option>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-xs text-slate-600">{t("fin6.bk.coachHelp")}</p>
    </div>
  );
}
