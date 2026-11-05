"use client";

import { useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import { useT } from "@/components/Language";
import { formatMinute } from "@/lib/interval";
import { shortDate } from "@/lib/region";
import type { MyAttendanceLine } from "@/lib/attendance";

/**
 * What the instructor and the venue's desk recorded about the signed-in customer at classes and lessons, and a guardian's about the people
 * they manage (lib/attendance.ts): the day, the class or coach, the venue and the mark. Never the instructor's note, never public, never
 * anybody else's. A mark is the instructor's own record, checked by nobody. Nothing is shown to a customer with nothing recorded.
 */
export default function MyAttendance() {
  const t = useT();
  const [rows, setRows] = useState<MyAttendanceLine[] | null>(null);

  useEffect(() => {
    fetch("/api/my/attendance", { cache: "no-store" })
      .then((res) => (res.ok ? readJson(res) : null))
      .then((data) => setRows(data?.attendance ?? []))
      .catch(() => setRows([]));
  }, []);

  if (rows === null || rows.length === 0) return null;
  return (
    <section data-testid="my-attendance">
      <h2 className="text-lg font-bold">{t("clsb.att.title")}</h2>
      <p className="mt-1 text-xs text-slate-600">{t("clsb.att.intro")}</p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm shadow-sm">
        {rows.slice(0, 60).map((r, i) => (
          <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <span className="min-w-0">
              <span className="font-medium">{r.kind === "lesson" ? t("clsb.att.lesson", { coach: r.title }) : r.title}</span>
              {r.forName && <span className="text-slate-500"> · {t("clsb.att.for", { name: r.forName })}</span>}
              <span className="text-slate-500">
                {" "}
                · {shortDate(r.date, t.locale)}, {formatMinute(r.startMin, t.locale)} · {r.venue}
              </span>
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">{t(`clsb.att.mark.${r.mark}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
