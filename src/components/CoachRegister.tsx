"use client";

import { useCallback, useState } from "react";
import { useT } from "@/components/Language";
import { RegisterPanel, type RegisterKey } from "@/components/RegisterPanel";
import { translateError } from "@/lib/i18n";

/**
 * A coach's roll call for one of their own lessons, at their private link (lib/attendance.ts): the names of who is on it, Present, Late,
 * Absent or Excused for each, and a walk-in by name. Opens on the lesson's day; a closed register is a manager's to correct. The coach
 * never sees another coach's lesson, a number, or anything else of the venue.
 */
export default function CoachRegister({ token, lessonId }: { token: string; lessonId: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const say = useCallback((key: RegisterKey, vars?: Record<string, string | number>) => t(`clsb.c.${key}`, vars), [t]);
  const load = useCallback(() => fetch(`/api/coach/${token}/register?id=${lessonId}`, { cache: "no-store" }), [token, lessonId]);
  const send = useCallback(
    (body: Record<string, unknown>) =>
      fetch(`/api/coach/${token}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: lessonId, ...body }) }),
    [token, lessonId]
  );
  return (
    <div className="mt-2 w-full">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-md border border-teal-300 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50">
        {t("clsb.c.rollCall")}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <RegisterPanel load={load} send={send} say={say} errorText={(data, fallback) => translateError(t, data) || fallback} />
        </div>
      )}
    </div>
  );
}
