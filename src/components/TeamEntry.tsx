"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import type { T } from "@/lib/i18n";

type Captained = { id: number; name: string; members: number };
type Member = { id: number; name: string | null; junior: boolean };

/**
 * Entering a team event as a team you captain (lib/teams.ts): the roster is picked from the team's members and each is
 * checked against the event's rules from what they declared, so nothing is typed. Shown only to somebody who captains
 * a team for the event's sport; the typed team and roster form stays as it was.
 */
export function TeamEntry({ t, sport, roster, act }: { t: T; sport: string; roster: { min: number; max: number } | null; act: (body: object) => Promise<void> }) {
  const [teams, setTeams] = useState<Captained[]>([]);
  const [teamId, setTeamId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [picked, setPicked] = useState<number[]>([]);

  useEffect(() => {
    void fetch(`/api/teams?captain=1&sport=${encodeURIComponent(sport)}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await readJson(r)) as { captained?: Captained[] }) : {}))
      .then((d) => {
        const list = (d as { captained?: Captained[] }).captained ?? [];
        setTeams(list);
        if (list[0]) setTeamId(String(list[0].id));
      })
      .catch(() => null);
  }, [sport]);
  useEffect(() => {
    if (!teamId) return;
    void fetch(`/api/teams/${teamId}`, { cache: "no-store" })
      .then((r) => readJson(r))
      .then((d: { team?: { roster?: Member[] } }) => {
        setMembers(d.team?.roster ?? []);
        setPicked([]);
      })
      .catch(() => null);
  }, [teamId]);

  if (teams.length === 0) return null;
  const input = "mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <form
      className="mb-3 space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void act({ action: "enter", teamId: Number(teamId), rosterMemberIds: picked });
      }}
    >
      <h3 className="text-sm font-semibold">{t("tm.ui.enterTeam")}</h3>
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {t("tml.team")}
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className={input} name="enterTeamId">
          {teams.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className="text-xs font-medium text-slate-500">
          {t("tm.ui.pickRoster")} {roster && t("tour.rosterSize", { min: roster.min, max: roster.max })}
        </legend>
        <div className="mt-1 grid gap-1 text-sm sm:grid-cols-2">
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2">
              <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((p) => p !== m.id))} />
              {m.name ?? t("tm.ui.junior")}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-slate-500">{t("tm.ui.pickNote")}</p>
      <div className="flex items-center gap-3">
        <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">{t("tour.enter")}</button>
        <Link href={`/teams/${teamId}`} className="text-sm text-teal-700 underline">
          {t("tm.ui.openTeam")}
        </Link>
      </div>
      <p className="text-xs text-slate-500">{t("tm.ui.typedInstead")}</p>
    </form>
  );
}
