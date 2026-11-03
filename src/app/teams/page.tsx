"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { useOfferedSports } from "@/components/OfferedSports";
import { ActivityGlyph } from "@/components/Glyph";
import { sportLabel, translateError } from "@/lib/i18n";
import type { Team } from "@/lib/teams";

/**
 * The teams you are on, or look after a child on, and starting one (lib/teams.ts). A team is a name your players
 * share from event to event; it holds no court and no money.
 */
export default function TeamsPage() {
  const t = useT();
  const sports = useOfferedSports();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", sport: "", published: false });

  const load = useCallback(async () => {
    const res = await fetch("/api/teams", { cache: "no-store" });
    if (res.status === 401) {
      setSignedIn(false);
      return setTeams([]);
    }
    const data = await readJson(res);
    setTeams(data.teams ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setError(null);
    const res = await fetch("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: form.name, sport: form.sport || sports[0], published: form.published }),
    });
    const data = await readJson(res);
    if (!res.ok) return setError(translateError(t, data) || data.error);
    window.location.href = `/teams/${data.team.id}`;
  }

  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("tm.ui.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("tm.ui.intro")}</p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!signedIn ? (
        <p className="text-sm text-slate-600">
          <Link href="/login?next=/teams" className="text-teal-700 underline">
            {t("tm.ui.signIn")}
          </Link>
        </p>
      ) : teams === null ? null : teams.length === 0 ? (
        <p className="text-sm text-slate-500">{t("tm.ui.none")}</p>
      ) : (
        <ul className="space-y-2">
          {teams.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
              <Link href={`/teams/${x.id}`} className="font-medium underline">
                <ActivityGlyph sport={x.sport} /> {x.name}
              </Link>
              <span className="text-slate-500">
                {sportLabel(t, x.sport)} · {t("tm.ui.members", { n: x.members })}
                {x.isCaptain && ` · ${t("tm.ui.captain")}`}
                {x.status === "archived" && ` · ${t("tm.ui.archived")}`}
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
          <h2 className="w-full font-semibold">{t("tm.ui.create")}</h2>
          <label className="flex flex-col text-xs text-slate-500">
            {t("tm.ui.name")}
            <input required minLength={3} maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} name="teamName" />
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            {t("tm.ui.sport")}
            <select value={form.sport || sports[0]} onChange={(e) => setForm({ ...form, sport: e.target.value })} className={input} name="teamSport">
              {sports.map((s) => (
                <option key={s} value={s}>
                  {sportLabel(t, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-slate-600">
            <input type="checkbox" checked={form.published} onChange={(e) => setForm({ ...form, published: e.target.checked })} />
            {t("tm.ui.publish")}
          </label>
          <button className="rounded-lg bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-700">{t("tm.ui.create")}</button>
          <p className="w-full text-xs text-slate-500">{t("tm.ui.publishNote")}</p>
        </form>
      )}
      <p className="text-sm text-slate-600">
        <Link href="/team-leagues" className="text-teal-700 underline">
          {t("tml.title")}
        </Link>
      </p>
    </div>
  );
}
