"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import { activityKeys } from "@/lib/activity-registry";
import { formatMinute } from "@/lib/interval";
import { sportLabel } from "@/lib/i18n";
import { addDays } from "@/lib/time";
import type { FixtureView, TeamLeague, TeamLeagueDetail } from "@/lib/team-leagues";
import { LoadFailed } from "./place";
import { todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { ManagerOnly, useStaffMay } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";
import type { StaffT } from "@/lib/staff-i18n";

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const label = "flex flex-col text-xs font-medium text-slate-500";
const small = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";
const primary = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";

type Template = { key: string; label: string; sports: string[]; rubbers: string[]; matchMinutes: number };
type Court = { id: number; name: string; sports: string[] };

/** The name of game `i` of a team match. */
function gameName(t: StaffT, kinds: string[], i: number): string {
  const kind = kinds[i];
  if (kind === "team") return t("tl.rubber.team");
  return t(kind === "singles" ? "tl.rubber.singles" : "tl.rubber.doubles", { n: kinds.slice(0, i + 1).filter((k) => k === kind).length });
}

/**
 * A venue's leagues of teams (lib/team-leagues.ts): set one up for a season, see the teams that entered, set the match
 * nights and make the fixture list (each fixture's court time is held), enter results, give a forfeit, move a fixture,
 * take a team out. Setting up, the fixture list, moving, giving a forfeit (and deciding a request for one, lib/team-forfeits.ts) and
 * taking a team out are a manager's; the desk enters results and may ask for a forfeit.
 */
export function TeamLeaguesPanel({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  // Closed until opened, and read only then: a venue with no team league has nothing to look at here.
  const [opened, setOpened] = useState(false);
  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer font-semibold">{t("tl.title")}</summary>
      {opened && <TeamLeaguesBody venue={venue} />}
    </details>
  );
}

function TeamLeaguesBody({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  const [list, setList] = useState<TeamLeague[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [courts, setCourts] = useState<Court[]>([]);
  const [open, setOpen] = useState<TeamLeagueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/team-leagues?venueId=${venue.id}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("q8b.loadFailed")));
      setList(data.leagues);
      setTemplates(data.templates ?? []);
      setCourts(data.courts ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("q8b.loadFailed"));
    }
  }, [venue.id, t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function show(id: number) {
    setError(null);
    const res = await fetch(`/api/admin/team-leagues/${id}`, { cache: "no-store" });
    const data = await readJson(res);
    if (!res.ok) return setError(t.err(data, t("q8b.loadFailed")));
    setOpen(data.league);
  }

  async function send(url: string, method: "POST" | "PATCH" | "DELETE", body?: object): Promise<boolean> {
    setError(null);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await readJson(res);
    if (!res.ok) {
      setError(t.err(data));
      return false;
    }
    if (data.league && "fixtures" in data.league) setOpen(data.league);
    await load();
    return true;
  }

  return (
    <section className="mt-3 space-y-3">
      <p className="text-sm text-slate-500">{t("tl.intro")}</p>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {open ? (
        <Manage t={t} l={open} courts={courts} send={send} close={() => setOpen(null)} />
      ) : (
        <>
          {loadError ? (
            <LoadFailed message={loadError} onRetry={() => void load()} />
          ) : list.length === 0 ? (
            <p className="text-sm text-slate-500">{t("tl.none")}</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {list.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{l.name}</span> · {t("tl.teamsCount", { n: l.teams })} · <span className="text-slate-500">{t(`tl.status.${l.status}`)}</span>
                  </span>
                  <button onClick={() => void show(l.id)} className="text-sm font-medium text-teal-700 underline">
                    {t("tn.open")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ManagerOnly may="teamLeagues">
            <Create t={t} venue={venue} templates={templates} courts={courts} send={send} />
          </ManagerOnly>
        </>
      )}
    </section>
  );
}

function Create({ t, venue, templates, courts, send }: { t: StaffT; venue: ManagedVenue; templates: Template[]; courts: Court[]; send: (url: string, m: "POST", body: object) => Promise<boolean> }) {
  const sports = activityKeys().filter((s) => venue.courts.some((c) => c.sport === s));
  const [f, setF] = useState({
    name: "",
    sport: sports[0] ?? "badminton",
    template: "",
    legs: "1",
    category: "open",
    ageMin: "",
    ageMax: "",
    membersOnly: false,
    startsOn: addDays(todayLocal(), 14),
    endsOn: addDays(todayLocal(), 120),
    slotsPerNight: "2",
    maxTeams: "12",
    rosterMin: "",
    rosterMax: "",
    description: "",
  });
  const [picked, setPicked] = useState<number[]>([]);
  const own = (sport: string) => templates.find((x) => x.sports.includes(sport));
  const chosen = templates.find((x) => x.key === f.template) ?? own(f.sport);
  const here = courts.filter((c) => c.sports.includes(f.sport));
  return (
    <form
      className="space-y-3 rounded-xl border border-dashed border-slate-300 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const num = (v: string) => (v === "" ? undefined : Number(v));
        const ok = await send("/api/admin/team-leagues", "POST", {
          venueId: venue.id,
          name: f.name,
          sport: f.sport,
          template: f.template || undefined,
          legs: Number(f.legs),
          category: f.category,
          ageMin: num(f.ageMin),
          ageMax: num(f.ageMax),
          membersOnly: f.membersOnly,
          startsOn: f.startsOn,
          endsOn: f.endsOn,
          slotsPerNight: num(f.slotsPerNight),
          maxTeams: num(f.maxTeams),
          rosterMin: num(f.rosterMin),
          rosterMax: num(f.rosterMax),
          description: f.description || undefined,
          courtIds: picked.filter((id) => here.some((c) => c.id === id)),
        });
        if (ok) setF({ ...f, name: "", description: "" });
      }}
    >
      <h3 className="font-semibold">{t("tl.setUp")}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          {t("c.name")}
          <input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`w-64 ${input}`} />
        </label>
        <label className={label}>
          {t("tn.sport")}
          <select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value, template: "" })} className={input}>
            {sports.map((s) => (
              <option key={s} value={s}>
                {t.locale === "en" ? s : sportLabel(t.customer, s)}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("lg.scoredAs")}
          <select value={f.template || own(f.sport)?.key || ""} onChange={(e) => setF({ ...f, template: e.target.value })} className={`w-72 ${input}`}>
            {templates.map((x) => (
              <option key={x.key} value={x.key}>
                {t.known(`srv.tpl.${x.key}`) ?? x.label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("tl.legs")}
          <select value={f.legs} onChange={(e) => setF({ ...f, legs: e.target.value })} className={input}>
            <option value="1">{t("tl.legs.1")}</option>
            <option value="2">{t("tl.legs.2")}</option>
          </select>
        </label>
        <label className={label}>
          {t("lg.whoCanPlay")}
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className={input}>
            <option value="open">{t("lg.anyone")}</option>
            <option value="women">{t("lg.womenOnly")}</option>
            <option value="men">{t("lg.menOnly")}</option>
          </select>
        </label>
        <label className={label}>
          {t("tl.ageMin")}
          <input type="number" min={0} max={120} value={f.ageMin} onChange={(e) => setF({ ...f, ageMin: e.target.value })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          {t("tl.ageMax")}
          <input type="number" min={0} max={120} value={f.ageMax} onChange={(e) => setF({ ...f, ageMax: e.target.value })} className={`w-20 ${input}`} />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
          <input type="checkbox" checked={f.membersOnly} onChange={(e) => setF({ ...f, membersOnly: e.target.checked })} />
          {t("tl.membersOnly")}
        </label>
        <label className={label}>
          {t("tl.startsOn")}
          <input type="date" required value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} className={input} />
        </label>
        <label className={label}>
          {t("tl.endsOn")}
          <input type="date" required value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} className={input} />
        </label>
        <label className={label}>
          {t("tl.slotsPerNight")}
          <input type="number" min={1} max={8} value={f.slotsPerNight} onChange={(e) => setF({ ...f, slotsPerNight: e.target.value })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          {t("tl.maxTeams")}
          <input type="number" min={2} max={24} value={f.maxTeams} onChange={(e) => setF({ ...f, maxTeams: e.target.value })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          {t("tl.rosterMin")}
          <input type="number" min={1} max={40} value={f.rosterMin} onChange={(e) => setF({ ...f, rosterMin: e.target.value })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          {t("tl.rosterMax")}
          <input type="number" min={1} max={40} value={f.rosterMax} onChange={(e) => setF({ ...f, rosterMax: e.target.value })} className={`w-20 ${input}`} />
        </label>
      </div>
      {chosen && (
        <p className="text-xs text-slate-500">
          {t("tl.madeOf", { games: chosen.rubbers.map((_, i) => gameName(t, chosen.rubbers, i)).join(", "), minutes: chosen.matchMinutes })} {t("lg.templateCaveat")}
        </p>
      )}
      <fieldset>
        <legend className="text-xs font-medium text-slate-500">{t("tl.courts")}</legend>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {here.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5">
              <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((p) => p !== c.id))} />
              {c.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label className={label}>
        {t("lg.about")}
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={2} className={input} />
      </label>
      <button className={primary}>{t("tl.setUpButton")}</button>
    </form>
  );
}

type Night = { date: string; time: string };

function Manage({ t, l, courts, send, close }: { t: StaffT; l: TeamLeagueDetail; courts: Court[]; send: (url: string, m: "POST" | "PATCH" | "DELETE", body?: object) => Promise<boolean>; close: () => void }) {
  const may = useStaffMay();
  const base = `/api/admin/team-leagues/${l.id}`;
  const [nights, setNights] = useState<Night[]>(l.nights.map((n) => ({ date: n.date, time: `${String(Math.floor(n.startMin / 60)).padStart(2, "0")}:${String(n.startMin % 60).padStart(2, "0")}` })));
  const [weekday, setWeekday] = useState("1");
  const [count, setCount] = useState("10");
  const [time, setTime] = useState("19:00");
  const editable = l.status === "forming" || l.status === "scheduled";
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + (m || 0);
  };
  const fill = () => {
    const out: Night[] = [];
    let d = l.startsOn < todayLocal() ? todayLocal() : l.startsOn;
    while (d <= l.endsOn && out.length < Number(count)) {
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === Number(weekday)) out.push({ date: d, time });
      d = addDays(d, 1);
    }
    setNights(out);
  };
  const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const clashes = l.fixtures.filter((f) => f.blackoutClash);
  const disputed = l.fixtures.filter((f) => f.status === "disputed");
  const dates = [...new Set(l.fixtures.map((f) => f.date))];
  return (
    <div className="space-y-4">
      <button onClick={close} className="text-sm text-teal-700 underline">
        {t("lg.back")}
      </button>
      <div>
        <h3 className="text-lg font-semibold">{l.name}</h3>
        <p className="text-sm text-slate-500">
          {t(`tl.status.${l.status}`)} · {t(l.legs === 2 ? "tl.legs.2" : "tl.legs.1")} · {t("tl.season", { from: l.startsOn, to: l.endsOn })} · {l.courts.map((c) => c.name).join(", ")}
        </p>
        <p className="text-xs text-slate-500">{t("tl.madeOf", { games: l.rubbers.map((_, i) => gameName(t, l.rubbers, i)).join(", "), minutes: l.rubberMinutes })}</p>
      </div>

      <section>
        <h4 className="text-sm font-semibold">{t("tl.teams", { n: l.entered.filter((e) => !e.withdrawn).length, max: l.maxTeams })}</h4>
        <ul className="mt-1 divide-y divide-slate-100 text-sm">
          {l.entered.map((e) => (
            <li key={e.id} className={`flex flex-wrap items-center justify-between gap-2 py-1.5 ${e.withdrawn ? "text-slate-400" : ""}`}>
              <span>
                {e.name}
                {e.withdrawn && ` (${t("tl.withdrawn")})`}
                <span className="text-xs text-slate-500">
                  {" "}
                  · {t("tl.rosterCount", { n: e.roster?.length ?? 0 })}
                  {e.homeCourtId && ` · ${t("tl.home", { court: l.courts.find((c) => c.id === e.homeCourtId)?.name ?? "" })}`}
                  {(e.blackouts ?? []).length > 0 && ` · ${t("tl.cannotPlay", { dates: e.blackouts!.join(", ") })}`}
                </span>
              </span>
              {!e.withdrawn && editable && may("teamLeagueRemove") && (
                <button className={small} onClick={() => void send(`${base}/teams/${e.id}`, "DELETE")}>
                  {t("tl.removeTeam")}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {editable && (
        <ManagerOnly may="teamLeagueRun">
          <section className="space-y-2 rounded-lg border border-slate-200 p-3">
            <h4 className="text-sm font-semibold">{t("tl.nights")}</h4>
            <p className="text-xs text-slate-500">{t("tl.nightsNote")}</p>
            <div className="flex flex-wrap items-end gap-2 text-sm">
              <label className={label}>
                {t("tl.weekday")}
                <select value={weekday} onChange={(e) => setWeekday(e.target.value)} className={input}>
                  {weekdays.map((w, i) => (
                    <option key={w} value={i}>
                      {t(`tl.wd.${w}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={label}>
                {t("tl.nightCount")}
                <input type="number" min={1} max={60} value={count} onChange={(e) => setCount(e.target.value)} className={`w-20 ${input}`} />
              </label>
              <label className={label}>
                {t("tl.startTime")}
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} />
              </label>
              <button type="button" className={small} onClick={fill}>
                {t("tl.fillNights")}
              </button>
              <button type="button" className={small} onClick={() => setNights([...nights, { date: l.startsOn, time }])}>
                {t("tl.addNight")}
              </button>
            </div>
            <ul className="space-y-1 text-sm">
              {nights.map((n, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input type="date" aria-label={t("tl.nightDate", { n: i + 1 })} value={n.date} onChange={(e) => setNights(nights.map((x, k) => (k === i ? { ...x, date: e.target.value } : x)))} className={input} />
                  <input type="time" aria-label={t("tl.nightTime", { n: i + 1 })} value={n.time} onChange={(e) => setNights(nights.map((x, k) => (k === i ? { ...x, time: e.target.value } : x)))} className={input} />
                  <button type="button" className={small} onClick={() => setNights(nights.filter((_, k) => k !== i))}>
                    {t("tl.removeNight")}
                  </button>
                </li>
              ))}
            </ul>
            <button className={primary} onClick={() => void send(base, "POST", { action: "generate", nights: nights.map((n) => ({ date: n.date, startMin: toMin(n.time) })) })}>
              {l.status === "scheduled" ? t("tl.makeAgain") : t("tl.make")}
            </button>
          </section>
        </ManagerOnly>
      )}

      {clashes.length > 0 && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t("tl.clashes", { n: clashes.length })}</p>}
      {disputed.length > 0 && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t("tl.disputed", { n: disputed.length })}</p>}

      {l.standings.length > 0 && (
        <section className="overflow-x-auto">
          <h4 className="text-sm font-semibold">{t("tl.table")}</h4>
          <table className="mt-1 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th scope="col">#</th>
                <th scope="col">{t("tl.col.team")}</th>
                <th scope="col">{t("tl.col.p")}</th>
                <th scope="col">{t("tl.col.w")}</th>
                <th scope="col">{t("tl.col.d")}</th>
                <th scope="col">{t("tl.col.l")}</th>
                <th scope="col">{t("tl.col.pts")}</th>
              </tr>
            </thead>
            <tbody>
              {l.standings.map((s) => (
                <tr key={s.leagueTeamId} className="border-t border-slate-100">
                  <td>{s.position}</td>
                  <td>{s.name}</td>
                  <td>{s.played}</td>
                  <td>{s.won}</td>
                  <td>{s.drawn}</td>
                  <td>{s.lost}</td>
                  <td className="font-semibold">{s.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {dates.map((date) => (
        <section key={date} className="rounded-lg border border-slate-200 p-3">
          <h4 className="text-sm font-semibold">{date}</h4>
          <ul className="mt-1 divide-y divide-slate-100">
            {l.fixtures
              .filter((f) => f.date === date)
              .map((f) => (
                <Fixture key={f.id} t={t} l={l} f={f} courts={courts} base={base} send={send} />
              ))}
          </ul>
        </section>
      ))}

      {editable && (
        <ManagerOnly may="teamLeagueRun">
          <button className={small} onClick={() => void send(base, "POST", { action: "close" })}>
            {t("tl.close")}
          </button>
        </ManagerOnly>
      )}
    </div>
  );
}

const FORFEIT_REASONS = ["no_show", "short_handed", "told_us", "other"] as const;

/**
 * Forfeit requests on a fixture (lib/team-forfeits.ts): who asked, which team, why, and where each stands. A manager confirms one (the forfeit,
 * through the usual path) or declines it with a reason; the desk, who may not give a forfeit, can ask for one and take its own request back.
 */
function ForfeitRequests({ t, f, base, send }: { t: StaffT; f: FixtureView; base: string; send: (url: string, m: "POST" | "PATCH" | "DELETE", body?: object) => Promise<boolean> }) {
  const may = useStaffMay();
  const [asking, setAsking] = useState(false);
  const [declining, setDeclining] = useState<number | null>(null);
  const [team, setTeam] = useState(String(f.home.id));
  const [reason, setReason] = useState<(typeof FORFEIT_REASONS)[number]>("no_show");
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");
  const requests = f.forfeitRequests ?? [];
  const line = (p: { teamId: number; name: string; position: number; points: number }) => t("ofs1.fr.standing", { pos: p.position, name: p.name, points: p.points });
  return (
    <div className="mt-1 space-y-1 text-xs">
      {requests.length > 0 && (
        <ul className="space-y-1">
          {requests.map((r) => (
            <li key={r.id} className={`rounded-md border p-2 ${r.status === "open" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
              <p>
                <strong>{t("ofs1.fr.requested", { by: r.by, team: r.forfeitTeam.name })}</strong> · {t(`ofs1.fr.reason.${r.reason}`)}
                {r.note && <span> · “{r.note}”</span>}
              </p>
              <p className="text-slate-600">
                {t(`ofs1.fr.status.${r.status}`)}
                {r.decidedBy ? ` · ${r.decidedBy}` : ""}
                {r.decisionNote ? ` · ${r.decisionNote}` : ""}
              </p>
              {r.status === "confirmed" && r.standingsBefore && r.standingsAfter && (
                <p className="text-slate-600">
                  {t("ofs1.fr.tableBefore")}: {r.standingsBefore.filter((p) => p.teamId === f.home.id || p.teamId === f.away.id).map(line).join(", ")} · {t("ofs1.fr.tableAfter")}:{" "}
                  {r.standingsAfter.filter((p) => p.teamId === f.home.id || p.teamId === f.away.id).map(line).join(", ")}
                </p>
              )}
              {r.status === "open" && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {may("teamForfeitDecide") && (
                    <>
                      <button className={small} onClick={() => void send(`${base}/forfeit-requests/${r.id}`, "POST", { confirm: true, version: f.version })}>
                        {t("ofs1.fr.confirm")}
                      </button>
                      <button className={small} aria-expanded={declining === r.id} onClick={() => setDeclining(declining === r.id ? null : r.id)}>
                        {t("ofs1.fr.decline")}
                      </button>
                    </>
                  )}
                  {r.byKind === "staff" && (
                    <button className={small} onClick={() => void send(`${base}/forfeit-requests/${r.id}`, "DELETE")}>
                      {t("ofs1.fr.withdraw")}
                    </button>
                  )}
                </div>
              )}
              {declining === r.id && (
                <form
                  className="mt-1 flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send(`${base}/forfeit-requests/${r.id}`, "POST", { decline: true, reason: why }).then((ok) => ok && (setDeclining(null), setWhy("")));
                  }}
                >
                  <label className={label}>
                    {t("ofs1.fr.declineWhy")}
                    <input required minLength={3} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} className={`w-64 ${input}`} />
                  </label>
                  <button className={small}>{t("ofs1.fr.declineSend")}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* The desk may ask; a manager has the forfeit buttons above. */}
      {f.status === "scheduled" && !may("teamFixtureForfeit") && (
        <>
          <p className="text-slate-500">{t("ofs1.fr.deskNote")}</p>
          <button className={small} aria-expanded={asking} onClick={() => setAsking(!asking)}>
            {t("ofs1.fr.ask")}
          </button>
          {asking && (
            <form
              className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send(`${base}/fixtures/${f.id}/forfeit-requests`, "POST", { forfeitTeam: Number(team), reason, note }).then((ok) => ok && (setAsking(false), setNote("")));
              }}
            >
              <label className={label}>
                {t("ofs1.fr.team")}
                <select value={team} onChange={(e) => setTeam(e.target.value)} className={input}>
                  <option value={f.home.id}>{f.home.name}</option>
                  <option value={f.away.id}>{f.away.name}</option>
                </select>
              </label>
              <label className={label}>
                {t("ofs1.fr.reason")}
                <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} className={input}>
                  {FORFEIT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {t(`ofs1.fr.reason.${r}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={label}>
                {t("ofs1.fr.note")}
                <input maxLength={300} required={reason === "other"} value={note} onChange={(e) => setNote(e.target.value)} className={`w-64 ${input}`} />
              </label>
              <button className={small}>{t("ofs1.fr.send")}</button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function Fixture({ t, l, f, courts, base, send }: { t: StaffT; l: TeamLeagueDetail; f: FixtureView; courts: Court[]; base: string; send: (url: string, m: "POST" | "PATCH" | "DELETE", body?: object) => Promise<boolean> }) {
  const may = useStaffMay();
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [rows, setRows] = useState(() => l.rubbers.map((_, i) => ({ winner: f.rubbers[i]?.winner ?? "", score: f.rubbers[i]?.score ?? "", walkover: f.rubbers[i]?.walkover ?? false })));
  const [move, setMove] = useState({ date: f.date, time: `${String(Math.floor(f.startMin / 60)).padStart(2, "0")}:${String(f.startMin % 60).padStart(2, "0")}`, courtId: String(f.courtId ?? "") });
  const url = `${base}/fixtures/${f.id}`;
  const drawsOk = l.rules.scoring.kind === "tally" && l.rules.scoring.draws;
  const status = t(`tl.fixture.${f.status}`);
  const score = f.result && f.status !== "void" ? (f.result.score ?? `${f.result.home}-${f.result.away}`) : null;
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong>{f.home.name}</strong> {t("tl.v")} <strong>{f.away.name}</strong>
          {score && <span className="ml-2 font-mono">{score}</span>}
          {f.blackoutClash && <span className="ml-2 text-amber-700">{t("tl.clash")}</span>}
        </span>
        <span className="text-xs text-slate-500">
          {formatMinute(f.startMin, t.locale)}
          {f.courtName && ` · ${f.courtName}`} · {status}
        </span>
      </div>
      <div className="mt-1 space-x-2">
        <button className={small} aria-expanded={open} onClick={() => setOpen(!open)}>
          {t("tl.enterResult")}
        </button>
        {f.status !== "scheduled" && (
          <button className={small} onClick={() => void send(url, "POST", { clear: true, version: f.version })}>
            {t("tl.clear")}
          </button>
        )}
        {f.status !== "void" && (
          <button className={small} onClick={() => void send(url, "POST", { void: true, version: f.version })}>
            {t("tl.void")}
          </button>
        )}
        {/* A forfeit changes the table and what follows: a manager's (lib/roles.ts). The desk asks for one below. */}
        {f.status !== "forfeit" && may("teamFixtureForfeit") && (
          <>
            <button className={small} onClick={() => void send(`${url}/forfeit`, "POST", { forfeitBy: f.home.id, version: f.version })}>
              {t("tl.forfeitBy", { team: f.home.name })}
            </button>
            <button className={small} onClick={() => void send(`${url}/forfeit`, "POST", { forfeitBy: f.away.id, version: f.version })}>
              {t("tl.forfeitBy", { team: f.away.name })}
            </button>
          </>
        )}
        {f.status === "scheduled" && may("teamFixtureMove") && (
          <button className={small} aria-expanded={moving} onClick={() => setMoving(!moving)}>
            {t("tl.move")}
          </button>
        )}
      </div>
      {f.status === "disputed" && f.disputeNote && <p className="mt-1 text-xs text-slate-600">{t("tl.disputeNote", { note: f.disputeNote })}</p>}
      <ForfeitRequests t={t} f={f} base={base} send={send} />
      {open && (
        <form
          className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(url, "POST", {
              version: f.version,
              rubbers: rows.map((r) => ({ winner: r.winner === "" ? null : r.winner, score: r.walkover ? undefined : r.score, walkover: r.walkover })),
            }).then((ok) => ok && setOpen(false));
          }}
        >
          <p className="text-xs text-slate-500">{t("tl.scoreHint", { home: f.home.name })}</p>
          {l.rubbers.map((_, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-24 text-slate-500">{gameName(t, l.rubbers, i)}</span>
              <select value={rows[i].winner} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, winner: e.target.value as "home" | "away" | "" } : r)))} className={input} aria-label={`${gameName(t, l.rubbers, i)}: ${t("tl.winner")}`}>
                <option value="">{drawsOk ? t("tl.draw") : t("tl.winner")}</option>
                <option value="home">{f.home.name}</option>
                <option value="away">{f.away.name}</option>
              </select>
              <input
                value={rows[i].score}
                disabled={rows[i].walkover}
                onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, score: e.target.value } : r)))}
                className={`w-48 ${input}`}
                aria-label={`${gameName(t, l.rubbers, i)}: ${t("tl.score")}`}
              />
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={rows[i].walkover} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, walkover: e.target.checked } : r)))} />
                {t("tl.walkover")}
              </label>
            </div>
          ))}
          <button className={small}>{t("tl.save")}</button>
        </form>
      )}
      {moving && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const [h, m] = move.time.split(":").map(Number);
            void send(url, "PATCH", { date: move.date, startMin: h * 60 + (m || 0), courtId: move.courtId ? Number(move.courtId) : undefined, version: f.version }).then((ok) => ok && setMoving(false));
          }}
        >
          <label className={label}>
            {t("tl.moveDate")}
            <input type="date" required value={move.date} onChange={(e) => setMove({ ...move, date: e.target.value })} className={input} />
          </label>
          <label className={label}>
            {t("tl.startTime")}
            <input type="time" required value={move.time} onChange={(e) => setMove({ ...move, time: e.target.value })} className={input} />
          </label>
          <label className={label}>
            {t("tl.court")}
            <select value={move.courtId} onChange={(e) => setMove({ ...move, courtId: e.target.value })} className={input}>
              {l.courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {courts.find((x) => x.id === c.id)?.name ?? c.name}
                </option>
              ))}
            </select>
          </label>
          <button className={small}>{t("tl.moveSave")}</button>
        </form>
      )}
    </li>
  );
}
