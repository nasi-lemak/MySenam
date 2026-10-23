"use client";

import { activityIcon } from "@/lib/activity-registry";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/components/Language";
import { sportLabel } from "@/lib/i18n";
import { addDays, todayISO } from "@/lib/time";
import { type Sport } from "@/lib/types";
import { DAY_PARTS, type DayPart } from "@/lib/day-parts";
import { intlTag } from "@/lib/region";

const TIMES = DAY_PARTS;
/** The activities shown as buttons; the rest are one pick away, so thirty don't bury the button. */
const SHOWN = 8;
type Time = DayPart;

/**
 * What most people come for — badminton, tonight, near me — in three taps
 * from the home page, straight to the courts that are free. Every choice is
 * a button; the search page takes it from there, with everything else.
 */
export function QuickSearch({ sports }: { sports: Sport[] }) {
  const t = useT();
  const router = useRouter();
  const today = todayISO();
  const [sport, setSport] = useState<Sport | null>(sports[0] ?? null);
  const [date, setDate] = useState(today);
  const [time, setTime] = useState<Time>("any");
  const [near, setNear] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [noLocation, setNoLocation] = useState(false);
  const later = Array.from({ length: 5 }, (_, i) => addDays(today, i + 2));
  const dayName = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(intlTag(t.locale), { weekday: "short", day: "numeric", timeZone: "UTC" });

  function locate() {
    if (near) return setNear(null);
    if (!navigator.geolocation) return setNoLocation(true);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setNear({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        setNoLocation(true);
        setLocating(false);
      },
      { timeout: 10_000 }
    );
  }

  function go() {
    const q = new URLSearchParams({ date });
    if (sport) q.set("sport", sport);
    const hours = TIMES[time];
    if (time !== "any") {
      q.set("from", String(hours[0]));
      q.set("to", String(hours[1]));
    }
    if (near) {
      q.set("near", `${near.lat.toFixed(5)},${near.lng.toFixed(5)}`);
      q.set("km", "10");
    }
    router.push(`/search?${q}`);
  }

  const chip = (on: boolean) =>
    `rounded-full px-3 py-1.5 text-sm font-medium transition ${
      on ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
    }`;
  return (
    <div className="mt-6 space-y-3 rounded-xl bg-white p-4 text-slate-900 shadow-lg">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("quick.sport")}>
        {sports.slice(0, SHOWN).map((s) => (
          <button key={s} type="button" aria-pressed={sport === s} onClick={() => setSport(s)} className={chip(sport === s)}>
            {activityIcon(s)} {sportLabel(t, s)}
          </button>
        ))}
        {sports.length > SHOWN && (
          <select
            aria-label={t("quick.moreActivities")}
            value={sport && sports.indexOf(sport) >= SHOWN ? sport : ""}
            onChange={(e) => e.target.value && setSport(e.target.value)}
            className={`${chip(sport !== null && sports.indexOf(sport) >= SHOWN)} pr-2`}
          >
            <option value="">{t("quick.moreActivities")}</option>
            {sports.slice(SHOWN).map((s) => (
              <option key={s} value={s}>
                {activityIcon(s)} {sportLabel(t, s)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("quick.when")}>
        <button type="button" aria-pressed={date === today} onClick={() => setDate(today)} className={chip(date === today)}>
          {t("search.today")}
        </button>
        <button type="button" aria-pressed={date === addDays(today, 1)} onClick={() => setDate(addDays(today, 1))} className={chip(date === addDays(today, 1))}>
          {t("quick.tomorrow")}
        </button>
        <select
          aria-label={t("quick.otherDay")}
          value={later.includes(date) ? date : ""}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className={`${chip(later.includes(date))} pr-2`}
        >
          <option value="">{t("quick.otherDay")}</option>
          {later.map((d) => (
            <option key={d} value={d}>
              {dayName(d)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("quick.time")}>
        {(Object.keys(TIMES) as Time[]).map((k) => (
          <button key={k} type="button" aria-pressed={time === k} onClick={() => setTime(k)} className={chip(time === k)}>
            {t(`quick.time.${k}`)}
          </button>
        ))}
        <button type="button" aria-pressed={near !== null} onClick={locate} className={chip(near !== null)}>
          📍 {locating ? t("near.locating") : t("near.me")}
        </button>
      </div>
      {noLocation && <p className="text-xs text-slate-500">{t("near.locationFailed")}</p>}
      <button type="button" onClick={go} className="w-full rounded-lg bg-teal-600 py-3 font-semibold text-white hover:bg-teal-700">
        🔍 {t("quick.go")}
      </button>
    </div>
  );
}
