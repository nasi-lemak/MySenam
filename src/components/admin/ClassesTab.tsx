"use client";

import { activityIcon } from "@/lib/activity-registry";
import { ClockField } from "@/components/ClockField";
import { useCallback, useEffect, useState } from "react";
import { CoachesPanel } from "./CoachesPanel";
import { formatHour } from "@/lib/time";
import { MAX_CLASS_WEEKS } from "@/lib/types";
import type { Booking, ClassSession, WaitlistEntry } from "@/lib/types";
import { todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { money } from "@/lib/region";
import type { ClassStatus } from "@/lib/types";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";
import { WaitlistJoin, WaitlistQueue } from "./WaitlistJoin";

const STATUS: Record<ClassStatus, StaffPhrase> = { scheduled: "cls.status.scheduled", cancelled: "cls.status.cancelled" };
const ONLY: Record<string, StaffPhrase> = { women: "cls.onlyWomen", men: "cls.onlyMen" };

/* ---------------- Classes tab ---------------- */

export function ClassesTab({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [classes, setClasses] = useState<ClassSession[] | null>(null);
  const [roster, setRoster] = useState<{
    session: ClassSession;
    roster: Booking[];
    waitlist?: WaitlistEntry[];
  } | null>(null);
  const [waiting, setWaiting] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    courtId: "",
    name: "",
    instructor: "",
    date: todayLocal(),
    // Minutes of the day: classes start and end on any minute.
    start: 19 * 60,
    end: 20 * 60,
    capacity: "12",
    price: "25",
    weeks: "1",
    termOff: "0",
    who: "anyone",
  });

  const venue = venues.find((v) => v.id === venueId);
  // Only shared facilities can host a class; a single court has one place.
  const hostable = (venue?.courts ?? []).filter((c) => c.capacity > 1);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/classes?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("cls.loadFailed")));
      setClasses(data.classes);
      setWaiting(data.waiting ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cls.loadFailed"));
      setClasses(null);
    }
  }, [venueId, t]);

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
          start: form.start,
          end: form.end,
          capacity: Number(form.capacity),
          price: Number(form.price),
          weeks: Number(form.weeks),
          termOffPercent: Number(form.weeks) > 1 ? Number(form.termOff) : null,
          who: form.who,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("cls.scheduleFailed")));
      setNotice(
        data.classes.length > 1
          ? t("cls.scheduledSeries", { n: data.classes.length, code: data.seriesCode })
          : t("cls.scheduledOne", { name: form.name })
      );
      setForm({ ...form, name: "", instructor: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cls.scheduleFailed"));
    }
  }

  async function cancelClass(session: ClassSession) {
    if (!window.confirm(t("cls.cancelConfirm", { name: session.name, date: session.date, n: session.enrolled }))) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/classes/${session.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("cls.cancelFailed")));
      setNotice(t("cls.cancelled", { n: data.released }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cls.cancelFailed"));
    }
  }

  async function openRoster(session: ClassSession) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/classes/${session.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("cls.rosterFailed")));
      setRoster(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cls.rosterFailed"));
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  // The sentence around the link-like name, so each language can put it where it reads naturally.
  const [needsBefore, needsAfter] = t("cls.needsShared", { place: "\u0000" }).split("\u0000");
  const headings: (StaffPhrase | null)[] = [
    "cls.col.class",
    "cls.col.instructor",
    "cls.col.where",
    "cls.col.when",
    "cls.col.enrolled",
    "cls.col.waiting",
    "cls.col.price",
    null,
    null,
  ];

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
                {headings.map((h, i) => (
                  <th key={i} className="px-3 py-2 font-semibold">
                    {h ? t(h) : ""}
                  </th>
                ))}
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
                    {activityIcon(session.sport)} {session.courtName}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {session.date} · {formatHour(session.startHour, t.locale)}–{formatHour(session.endHour, t.locale)}
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
                  <td className="px-3 py-2">
                    {money(session.price)}
                    {session.who !== "anyone" && (
                      <span className="ml-1 text-xs text-fuchsia-700">{ONLY[session.who] ? t(ONLY[session.who]) : session.who}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        session.status === "scheduled"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {STATUS[session.status] ? t(STATUS[session.status]) : session.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {session.status === "scheduled" && (
                      <button
                        onClick={() => cancelClass(session)}
                        className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        {t("c.cancel")}
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
          {t("cls.none")}
        </div>
      )}

      {hostable.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          {needsBefore}
          <span className="font-medium">{t("cls.courtsRates")}</span>
          {needsAfter}
        </p>
      ) : (
        <form
          onSubmit={schedule}
          className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
        >
          <div className="w-full text-sm font-semibold text-slate-700">{t("cls.scheduleTitle")}</div>
          <input
            required minLength={2} placeholder={t("cls.namePh")} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`w-40 ${inputClass}`}
          />
          <input
            required minLength={2} placeholder={t("cls.col.instructor")} value={form.instructor}
            onChange={(e) => setForm({ ...form, instructor: e.target.value })}
            className={`w-36 ${inputClass}`}
          />
          <select
            required value={form.courtId}
            onChange={(e) => setForm({ ...form, courtId: e.target.value })}
            className={inputClass}
          >
            <option value="">{t("cls.wherePh")}</option>
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
          <ClockField label={t("cls.starts")} value={form.start} onChange={(m) => setForm({ ...form, start: m })} className={`w-28 ${inputClass}`} />
          <ClockField label={t("cls.ends")} value={form.end} after={form.start} onChange={(m) => setForm({ ...form, end: m })} className={`w-28 ${inputClass}`} />
          <input
            required type="number" min={1} value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            title={t("cls.seats")} className={`w-20 ${inputClass}`}
          />
          <input
            required type="number"
            step={0.01} min={0} value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            title={t("cls.pricePer")} className={`w-20 ${inputClass}`}
          />
          <select
            value={form.who}
            onChange={(e) => setForm({ ...form, who: e.target.value })}
            title={t("cls.whoCan")}
            className={inputClass}
          >
            <option value="anyone">{t("cls.anyone")}</option>
            <option value="women">{t("cls.womenOnly")}</option>
            <option value="men">{t("cls.menOnly")}</option>
          </select>
          <select
            value={form.weeks}
            onChange={(e) => setForm({ ...form, weeks: e.target.value })}
            title={t("cls.repeat")}
            className={inputClass}
          >
            {Array.from({ length: MAX_CLASS_WEEKS }, (_, i) => i + 1).map((w) => (
              <option key={w} value={w}>
                {w === 1 ? t("cls.once") : t("cls.nWeeks", { n: w })}
              </option>
            ))}
          </select>
          {Number(form.weeks) > 1 && (
            <select
              value={form.termOff}
              onChange={(e) => setForm({ ...form, termOff: e.target.value })}
              title={t("cls.termOffTitle")}
              className={inputClass}
            >
              {[0, 5, 10, 15, 20, 25, 30].map((p) => (
                <option key={p} value={p}>
                  {p === 0 ? t("cls.noTermDiscount") : t("cls.termOff", { p })}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
          >
            {t("cls.schedule")}
          </button>
        </form>
      )}

      {roster && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold">{roster.session.name}</h3>
            <p className="mt-1 text-sm text-slate-600">
              {t("cls.sessionWhen", {
                date: roster.session.date,
                start: formatHour(roster.session.startHour, t.locale),
                end: formatHour(roster.session.endHour, t.locale),
                instructor: roster.session.instructor,
              })}
            </p>
            {/* Who waits, and who put them there; an entry the venue made can be taken off (WaitlistJoin.tsx). */}
            {venue && roster.waitlist && (
              <WaitlistQueue venueId={venue.id} entries={roster.waitlist} onChange={() => void openRoster(roster.session)} />
            )}
            {/* A full class: a caller at the counter joins its queue. */}
            {venue && roster.session.status === "scheduled" && roster.session.enrolled >= roster.session.capacity && (
              <WaitlistJoin
                key={roster.session.id}
                venueId={venue.id}
                target={{ classId: roster.session.id, who: roster.session.who }}
                label={roster.session.name}
                onDone={() => void openRoster(roster.session)}
              />
            )}
            {roster.roster.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">{t("cls.nobody")}</p>
            ) : (
              <ul className="mt-4 space-y-1.5 text-sm">
                {roster.roster.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3">
                    <span className={b.status === "cancelled" ? "text-slate-400 line-through" : ""}>
                      {/* The person taking the place, where it is somebody the customer booked for. */}
                      {b.participantName ? t("apr.child.bookedFor", { name: b.participantName, adult: b.name }) : b.name}
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
                        {b.checkedInAt ? t("cls.checkedIn") : t("cls.expected")}
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
              {t("c.close")}
            </button>
          </div>
        </div>
      )}
      {venue && <CoachesPanel key={venue.id} venue={venue} />}
    </div>
  );
}
