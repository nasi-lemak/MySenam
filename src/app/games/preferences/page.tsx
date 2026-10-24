"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { NearPicker, type NearChoice } from "@/components/NearPicker";
import type { DayPart, Intensity, MatchNotice, PlayerProfile } from "@/lib/player-profiles";

const PARTS: DayPart[] = ["morning", "afternoon", "evening"];
const INTENSITIES: Intensity[] = ["casual", "competitive", "any"];
const NOTICES: MatchNotice[] = ["none", "digest", "each"];

/**
 * How the player likes to play, which is what suggestions are worked out
 * from (lib/player-profiles.ts), and who they have blocked.
 */
export default function PreferencesPage() {
  const t = useT();
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [blocks, setBlocks] = useState<{ userId: number; name: string }[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/my/profile", { cache: "no-store" });
      if (res.status === 401) return setSignedOut(true);
      setProfile((await res.json()).profile);
      const b = await fetch("/api/players/blocks", { cache: "no-store" });
      if (b.ok) setBlocks((await b.json()).blocks);
    })();
  }, []);

  if (signedOut)
    return (
      <Link href="/login?next=/games/preferences" className="text-teal-700 underline">
        {t("games.signInToJoin")}
      </Link>
    );
  if (!profile) return null;

  const set = (patch: Partial<PlayerProfile>) => setProfile({ ...profile, ...patch });
  const toggle = <V,>(list: V[], v: V) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  // Sunday first, in the reader's language: 2023-01-01 was a Sunday.
  const dayName = (d: number) => new Intl.DateTimeFormat(t.locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + d)));
  const near: NearChoice | null = profile.near ? { ...profile.near, km: profile.maxKm, where: null } : null;
  const chip = (on: boolean) =>
    `rounded-full px-3 py-1 text-sm font-medium ${on ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"}`;
  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

  async function save() {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/my/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
    const data = await res.json();
    if (!res.ok) return setError(data.error);
    setProfile(data.profile);
    setNotice(t("prefs.saved"));
  }

  async function unblock(userId: number) {
    const res = await fetch("/api/players/blocks", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
    if (res.ok) setBlocks((await res.json()).blocks);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link href="/games" className="text-sm text-teal-700 underline">
          ← {t("games.title")}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t("games.preferences")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("prefs.intro")}</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          {t("prefs.area")}
          <input value={profile.area ?? ""} maxLength={80} onChange={(e) => set({ area: e.target.value || null })} className={input} name="area" />
        </label>
        <div className="space-y-1 text-sm text-slate-700">
          <div>{t("prefs.near")}</div>
          <NearPicker value={near} onChange={(n) => set(n ? { near: { lat: n.lat, lng: n.lng }, maxKm: n.km } : { near: null })} />
          <p className="text-xs text-slate-500">{t("prefs.nearNote")}</p>
        </div>
        <fieldset className="space-y-2 text-sm">
          <legend className="text-slate-700">{t("prefs.days")}</legend>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <button type="button" key={d} onClick={() => set({ days: toggle(profile.days, d) })} className={chip(profile.days.includes(d))} aria-pressed={profile.days.includes(d)}>
                {dayName(d)}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-2 text-sm">
          <legend className="text-slate-700">{t("prefs.times")}</legend>
          <div className="flex flex-wrap gap-2">
            {PARTS.map((p) => (
              <button type="button" key={p} onClick={() => set({ times: toggle(profile.times, p) })} className={chip(profile.times.includes(p))} aria-pressed={profile.times.includes(p)}>
                {t(`prefs.time.${p}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            {t("games.intensity")}
            <select value={profile.intensity} onChange={(e) => set({ intensity: e.target.value as Intensity })} className={input} name="intensity">
              {INTENSITIES.map((i) => (
                <option key={i} value={i}>
                  {t(`games.intensity.${i}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            {t("prefs.maxShare")}
            <input
              type="number"
              min={0}
              step={0.5}
              value={profile.maxShare ?? ""}
              onChange={(e) => set({ maxShare: e.target.value === "" ? null : Number(e.target.value) })}
              className={`w-28 ${input}`}
              name="maxShare"
            />
          </label>
        </div>
        <fieldset className="space-y-1 text-sm">
          <legend className="text-slate-700">{t("prefs.age")}</legend>
          <div className="flex flex-wrap gap-4">
            {([
              ["adult", true],
              ["minor", false],
              ["unsaid", null],
            ] as const).map(([key, value]) => (
              <label key={key} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="adult"
                  checked={profile.adult === value}
                  onChange={() => set(value === true ? { adult: true } : { adult: value, discoverable: false, invitable: false })}
                />
                {t(`prefs.age.${key}`)}
              </label>
            ))}
          </div>
          <p className="text-xs text-slate-500">{t("prefs.ageNote")}</p>
        </fieldset>
        <label className={`flex items-start gap-2 text-sm ${profile.adult === true ? "text-slate-700" : "text-slate-400"}`}>
          <input type="checkbox" name="discoverable" disabled={profile.adult !== true} checked={profile.discoverable} onChange={(e) => set({ discoverable: e.target.checked })} />
          {t("prefs.discoverable")}
        </label>
        <label className={`flex items-start gap-2 text-sm ${profile.adult === true ? "text-slate-700" : "text-slate-400"}`}>
          <input type="checkbox" name="invitable" disabled={profile.adult !== true} checked={profile.invitable} onChange={(e) => set({ invitable: e.target.checked })} />
          {t("prefs.invitable")}
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          {t("prefs.notify")}
          <select value={profile.notifyMatches} onChange={(e) => set({ notifyMatches: e.target.value as MatchNotice })} className={`w-48 ${input}`} name="notifyMatches">
            {NOTICES.map((n) => (
              <option key={n} value={n}>
                {t(`prefs.notify.${n}`)}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded-lg bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-700">{t("prefs.save")}</button>
      </form>

      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">{t("prefs.blocks")}</h2>
        {blocks.length === 0 ? (
          <p className="mt-1 text-slate-500">{t("prefs.noBlocks")}</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {blocks.map((b) => (
              <li key={b.userId} className="flex items-center gap-2">
                {b.name}
                <button onClick={() => void unblock(b.userId)} className="rounded-md border border-slate-300 px-2 py-0.5 text-xs hover:border-teal-500">
                  {t("prefs.unblock")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
