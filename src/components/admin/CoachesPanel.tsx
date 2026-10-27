"use client";

import { sportsOf } from "@/lib/court-activities";
import { useCallback, useEffect, useState } from "react";
import type { Coach, CoachHours } from "@/lib/coaching";
import type { CoachContact, NewCoachLink } from "@/lib/coach-schedule";
import { type Sport } from "@/lib/types";
import { formatMinute } from "@/lib/interval";
import { ClockField } from "@/components/ClockField";
import { money } from "@/lib/region";
import type { ManagedVenue } from "./shared";
import { sportLabel } from "@/lib/i18n";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

const DAYS: StaffPhrase[] = ["coach.day.0", "coach.day.1", "coach.day.2", "coach.day.3", "coach.day.4", "coach.day.5", "coach.day.6"];

interface Draft {
  id?: number;
  name: string;
  bio: string;
  sports: Sport[];
  rate: string;
  days: number[];
  from: number;
  until: number;
}

const blank = (sports: Sport[]): Draft => ({ name: "", bio: "", sports: sports.slice(0, 1), rate: "80", days: [1, 2, 3, 4, 5], from: 9 * 60, until: 17 * 60 });

/**
 * A venue's coaches for one-to-one lessons: who, what they coach, their fee
 * an hour on top of the court, and when they take lessons. Customers book
 * them from the venue's page; a lesson is a booking like any other.
 */
export function CoachesPanel({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  const sports = sportsOf(venue.courts);
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [contacts, setContacts] = useState<Record<number, CoachContact>>({});
  const [emails, setEmails] = useState<Record<number, string>>({});
  // A link just made: shown this once, since only its hash is kept.
  const [fresh, setFresh] = useState<Record<number, NewCoachLink>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Who chooses the coach of a new lesson here: the customer (the default), or the venue (lib/lesson-coaches.ts).
  const [choice, setChoice] = useState<"customer" | "venue">("customer");

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/coaches?venueId=${venue.id}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setCoaches(data.coaches);
    setContacts(data.contacts ?? {});
    setChoice(data.choice === "venue" ? "venue" : "customer");
  }, [venue.id]);

  async function choose(next: "customer" | "venue") {
    setError(null);
    const res = await fetch("/api/admin/coaches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId: venue.id, action: "choice", choice: next }),
    });
    const data = await res.json();
    if (!res.ok) return setError(t.err(data, t("co6.ch.failed")));
    setChoice(data.choice);
  }

  async function contact(id: number, body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/admin/coaches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId: venue.id, id, ...body }),
    });
    const data = await res.json();
    if (!res.ok) return setError(t.err(data, t("coach.saveFailed")));
    setCoaches(data.coaches);
    setContacts(data.contacts ?? {});
    setFresh(data.link ? { ...fresh, [id]: data.link } : Object.fromEntries(Object.entries(fresh).filter(([k]) => Number(k) !== id)));
  }
  useEffect(() => {
    void load();
  }, [load]);

  function edit(c: Coach) {
    // One stretch of hours on the days they work: the first one's, which is all this form sets.
    const first: CoachHours | undefined = c.hours[0];
    setDraft({
      id: c.id,
      name: c.name,
      bio: c.bio ?? "",
      sports: c.sports,
      rate: String(c.rate),
      days: [...new Set(c.hours.map((h) => h.weekday))],
      from: first?.from ?? 9 * 60,
      until: first?.until ?? 17 * 60,
    });
  }

  async function save() {
    if (!draft) return;
    setError(null);
    const res = await fetch("/api/admin/coaches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venueId: venue.id,
        id: draft.id,
        name: draft.name,
        bio: draft.bio,
        sports: draft.sports,
        rate: Number(draft.rate),
        hours: draft.days.map((weekday) => ({ weekday, from: draft.from, until: draft.until })),
      }),
    });
    const data = await res.json();
    if (!res.ok) return setError(t.err(data, t("coach.saveFailed")));
    setCoaches(data.coaches);
    setDraft(null);
  }

  async function retire(c: Coach) {
    if (!confirm(t("coach.stopConfirm", { name: c.name }))) return;
    const res = await fetch(`/api/admin/coaches?venueId=${venue.id}&id=${c.id}`, { method: "DELETE" });
    if (res.ok) setCoaches((await res.json()).coaches);
  }

  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  const toggle = (on: boolean) => `rounded-md border px-2 py-1 text-xs font-medium ${on ? "border-teal-600 bg-teal-50 text-teal-800" : "border-slate-300 text-slate-600"}`;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">{t("coach.title")}</h3>
      <p className="mt-1 text-xs text-slate-500">
        {t("coach.intro")}
      </p>
      <label className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-slate-700">{t("co6.ch.title")}</span>
        <select value={choice} onChange={(e) => void choose(e.target.value === "venue" ? "venue" : "customer")} className={input}>
          <option value="customer">{t("co6.ch.customer")}</option>
          <option value="venue">{t("co6.ch.venue")}</option>
        </select>
      </label>
      <p className="mt-1 text-xs text-slate-500">{t("co6.ch.help")}</p>
      {error && !draft && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
      <ul className="mt-2 divide-y divide-slate-100">
        {coaches.map((c) => (
          <li key={c.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${c.active ? "" : "opacity-50"}`}>
            <span>
              <span className="font-medium">{c.name}</span> · {c.sports.map((s) => sportLabel(t.customer, s)).join(", ")} ·{" "}
              {t("coach.perHour", { amount: money(c.rate) })}
              <span className="block text-xs text-slate-500">
                {c.active
                  ? c.hours
                      .map((h) => t("coach.hoursSpan", { day: t(DAYS[h.weekday]), from: formatMinute(h.from), until: formatMinute(h.until) }))
                      .join(", ") || t("coach.noHours")
                  : t("coach.notTaking")}
              </span>
              {/* Set by the coach at their own link (lib/coaching.ts): days off, when nobody can book them. */}
              {c.active && c.timeOff.length > 0 && (
                <span className="block text-xs text-amber-800">
                  {t("coach.away", {
                    list: c.timeOff.map((o) => (o.from === o.until ? o.from : `${o.from} – ${o.until}`) + (o.reason ? ` (${o.reason})` : "")).join(", "),
                  })}
                </span>
              )}
              {c.active && (
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <input
                    aria-label={t("coach.emailLabel", { name: c.name })}
                    type="email"
                    placeholder={t("coach.emailPh")}
                    value={emails[c.id] ?? contacts[c.id]?.email ?? ""}
                    onChange={(e) => setEmails({ ...emails, [c.id]: e.target.value })}
                    className={`w-52 ${input}`}
                  />
                  <button type="button" className="font-medium text-teal-700 underline" onClick={() => void contact(c.id, { action: "email", email: emails[c.id] ?? contacts[c.id]?.email ?? "" })}>
                    {t("coach.saveEmail")}
                  </button>
                  {contacts[c.id]?.linkUntil ? (
                    <>
                      <span className="text-slate-500">{t("coach.linkUntil", { date: contacts[c.id]!.linkUntil!.slice(0, 10) })}</span>
                      <button
                        type="button"
                        className="font-medium text-teal-700 underline"
                        onClick={() => {
                          if (confirm(t("coach.newLinkConfirm", { name: c.name }))) void contact(c.id, { action: "link", on: true });
                        }}
                      >
                        {t("coach.newLink")}
                      </button>
                      <button
                        type="button"
                        className="font-medium text-red-700 underline"
                        onClick={() => {
                          if (confirm(t("coach.withdrawConfirm", { name: c.name }))) void contact(c.id, { action: "link", on: false });
                        }}
                      >
                        {t("coach.withdrawLink")}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="font-medium text-teal-700 underline" onClick={() => void contact(c.id, { action: "link", on: true })}>
                      {t("coach.makeLink")}
                    </button>
                  )}
                </span>
              )}
              {c.active && fresh[c.id] && (
                <span className="mt-1 block rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                  {t("coach.shownOnce")}
                  <input readOnly aria-label={t("coach.copyLink")} value={fresh[c.id].pageUrl} className={`mt-1 block w-full ${input}`} onFocus={(e) => e.target.select()} />
                  <button type="button" className="mr-3 font-medium text-teal-700 underline" onClick={() => void navigator.clipboard?.writeText(fresh[c.id].pageUrl)}>
                    {t("coach.copyLink")}
                  </button>
                  <button type="button" className="font-medium text-teal-700 underline" onClick={() => void navigator.clipboard?.writeText(fresh[c.id].calendarUrl)}>
                    {t("coach.copyCalendar")}
                  </button>
                </span>
              )}
            </span>
            <span className="flex gap-3 text-xs font-medium">
              <button onClick={() => edit(c)} className="text-teal-700 underline">
                {c.active ? t("c.change") : t("coach.bringBack")}
              </button>
              {c.active && (
                <button onClick={() => retire(c)} className="text-red-700 underline">
                  {t("coach.stop")}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {draft ? (
        <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap gap-2">
            <input aria-label={t("coach.namePh")} placeholder={t("coach.namePh")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={input} />
            <input aria-label={t("coach.fee")} type="number" min={0} step={0.01} value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} className={`w-24 ${input}`} />
          </div>
          <textarea aria-label={t("coach.about")} placeholder={t("coach.aboutPh")} rows={2} value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} className={`w-full ${input}`} />
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-slate-600">{t("coach.coaches")}</span>
            {sports.map((s) => (
              <button key={s} type="button" onClick={() => setDraft({ ...draft, sports: draft.sports.includes(s) ? draft.sports.filter((x) => x !== s) : [...draft.sports, s] })} className={toggle(draft.sports.includes(s))}>
                {sportLabel(t.customer, s)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-slate-600">{t("coach.takesLessons")}</span>
            {DAYS.map((d, i) => (
              <button key={d} type="button" onClick={() => setDraft({ ...draft, days: draft.days.includes(i) ? draft.days.filter((x) => x !== i) : [...draft.days, i] })} className={toggle(draft.days.includes(i))}>
                {t(d)}
              </button>
            ))}
            <ClockField label={t("c.from")} value={draft.from} onChange={(m) => setDraft({ ...draft, from: m })} className={input} />
            {t("coach.to")}
            <ClockField label={t("c.until")} value={draft.until} after={draft.from} onChange={(m) => setDraft({ ...draft, until: m })} className={input} />
          </div>
          <div className="flex gap-2">
            <button onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white">
              {t("coach.save")}
            </button>
            <button onClick={() => setDraft(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700">
              {t("c.cancel")}
            </button>
          </div>
          {error && <p className="text-xs font-medium text-red-700">{error}</p>}
        </div>
      ) : (
        <button onClick={() => setDraft(blank(sports))} className="mt-2 rounded-md border border-teal-300 px-3 py-1.5 text-xs font-semibold text-teal-700">
          {t("coach.add")}
        </button>
      )}
    </section>
  );
}
