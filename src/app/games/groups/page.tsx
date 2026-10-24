"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { useOfferedSports } from "@/components/OfferedSports";
import { activityIcon } from "@/lib/activity-registry";
import { sportLabel } from "@/lib/i18n";
import type { Group } from "@/lib/groups";
import type { Sport } from "@/lib/types";

/** Community groups to ask to join, and starting one (lib/groups.ts). */
export default function GroupsPage() {
  const t = useT();
  const sports = useOfferedSports();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", sport: "" as Sport | "", area: "", description: "", capacity: 12, privacy: false });

  const load = useCallback(async () => {
    const res = await fetch("/api/groups", { cache: "no-store" });
    const data = await res.json();
    setGroups(data.groups ?? []);
    setSignedIn(Boolean(data.signedIn));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setError(null);
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, sport: form.sport || sports[0], privacy: form.privacy ? "private" : "public" }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error);
    window.location.href = `/games/groups/${data.group.id}`;
  }

  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link href="/games" className="text-sm text-teal-700 underline">
          ← {t("games.title")}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t("groups.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("groups.intro")}</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {groups === null ? null : groups.length === 0 ? (
        <p className="text-sm text-slate-500">{t("groups.none")}</p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
              <Link href={`/games/groups/${g.id}`} className="font-medium underline">
                {activityIcon(g.sport)} {g.name}
              </Link>
              <span className="text-slate-500">
                {sportLabel(t, g.sport)}
                {g.area && ` · ${g.area}`} · {t("groups.members", { n: g.members })}
                {g.privacy === "private" && ` · ${t("games.private")}`}
                {g.mine?.status === "member" && ` · ${g.mine.role === "organiser" ? t("groups.organiser") : t("groups.member")}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {signedIn && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm"
        >
          <h2 className="w-full font-semibold">{t("groups.create")}</h2>
          <label className="flex flex-col text-xs text-slate-500">
            {t("groups.name")}
            <input required minLength={3} maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} name="groupName" />
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("games.allSports")}
            <select value={form.sport || sports[0]} onChange={(e) => setForm({ ...form, sport: e.target.value as Sport })} className={input} name="groupSport">
              {sports.map((s) => (
                <option key={s} value={s}>
                  {sportLabel(t, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("prefs.area")}
            <input maxLength={80} value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} className={input} />
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("groups.capacity")}
            <input type="number" min={2} max={60} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} className={`w-20 ${input}`} />
          </label>
          <input placeholder={t("groups.description")} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`min-w-0 flex-1 ${input}`} />
          <label className="flex items-center gap-1.5 pb-2 text-slate-600">
            <input type="checkbox" checked={form.privacy} onChange={(e) => setForm({ ...form, privacy: e.target.checked })} />
            {t("groups.private")}
          </label>
          <button className="rounded-lg bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-700">{t("groups.create")}</button>
        </form>
      )}
    </div>
  );
}
