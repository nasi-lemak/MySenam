"use client";

import { readJson } from "@/lib/read-response";
import { ActivityGlyph } from "@/components/Glyph";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { sportLabel, translateError } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import { formatMinute } from "@/lib/interval";
import type { FixtureView, TeamLeagueDetail } from "@/lib/team-leagues";

type Captained = { id: number; name: string; sport: string; members: number };
type RosterMember = { id: number; name: string | null; junior: boolean; role: string };

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const small = "rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";
const primary = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";

/** What game number `i` of a team match is called: "Singles 1", "Doubles 1", "The match". */
function gameLabel(t: T, kinds: string[], i: number): string {
  const kind = kinds[i];
  if (kind === "team") return t("tml.rubber.team");
  const n = kinds.slice(0, i + 1).filter((k) => k === kind).length;
  return t(kind === "singles" ? "tml.rubber.singles" : "tml.rubber.doubles", { n });
}

/**
 * One league of teams, for anybody: what it is, the table and every fixture and result, by team name (no player is named).
 * Signed in, a captain enters a team, sets the dates it cannot play, picks lineups and reports and answers results; a
 * member of an entered team sees its roster and lineups (lib/team-leagues.ts).
 */
export default function TeamLeaguePage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [league, setLeague] = useState<TeamLeagueDetail | null>(null);
  const [captained, setCaptained] = useState<Captained[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/team-leagues/${id}`, { cache: "no-store" });
    if (!res.ok) return setMissing(true);
    const data = await readJson(res);
    setLeague(data.league);
    setCaptained(data.captained ?? []);
    setSignedIn(Boolean(data.signedIn));
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: object): Promise<boolean> {
    setError(null);
    const res = await fetch(`/api/team-leagues/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await readJson(res);
    if (!res.ok) {
      setError(translateError(t, out) || out.error);
      return false;
    }
    if (out.league) setLeague(out.league);
    else await load();
    return true;
  }

  if (missing) return <p className="text-slate-500">{t("tml.none")}</p>;
  if (!league) return null;
  const x = league;
  const mine = x.mine ?? [];
  const myCaptain = mine.filter((m) => m.captain).map((m) => m.leagueTeamId);
  const enteredIds = new Set(x.entered.filter((e) => !e.withdrawn).map((e) => e.id));
  const fixtures = x.fixtures.filter((f) => !filter || f.home.id === Number(filter) || f.away.id === Number(filter));
  const nights = [...new Set(fixtures.map((f) => f.date))];
  const eligibleToEnter = captained.filter((c) => !x.entered.some((e) => !e.withdrawn && e.teamId === c.id));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/team-leagues" className="text-sm text-teal-700 underline">
          ← {t("tml.title")}
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          <ActivityGlyph sport={x.sport} /> {x.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          <Link href={`/venue/${x.venueId}`} className="underline">
            {x.venueName}
          </Link>{" "}
          · {sportLabel(t, x.sport)} · {t("tml.season", { from: x.startsOn, to: x.endsOn })}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {t(x.legs === 2 ? "tml.legs.2" : "tml.legs.1")} · {t("tml.teamsCount", { n: x.teams })}
          {x.category !== "open" && ` · ${t(`who.badge.${x.category}`)}`}
          {x.ageRange && ` · ${t("tml.ages", { range: x.ageRange.min !== null && x.ageRange.max !== null ? `${x.ageRange.min}–${x.ageRange.max}` : x.ageRange.min !== null ? `${x.ageRange.min}+` : `≤${x.ageRange.max}` })}`}
          {x.level && ` · ${t(`games.level.${x.level}`)}`}
          {x.membersOnly && ` · ${t("tml.membersOnly")}`} · {t(`tml.status.${x.status}`)}
        </p>
        {x.description && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{x.description}</p>}
        {x.rated && <p className="mt-2 text-sm text-slate-600">{t("rt.ratedNote")}</p>}
        <p className="mt-3 text-sm text-slate-600">{t("tml.how")}</p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {x.status === "forming" &&
        (signedIn ? (
          eligibleToEnter.length > 0 ? (
            <EnterForm t={t} league={x} teams={eligibleToEnter} post={post} />
          ) : (
            <p className="text-sm text-slate-500">{t("tml.enterNone", { sport: sportLabel(t, x.sport) })}</p>
          )
        ) : (
          <p className="text-sm">
            <Link href={`/login?next=/team-leagues/${id}`} className="text-teal-700 underline">
              {t("tml.signIn")}
            </Link>
          </p>
        ))}

      {x.entered
        .filter((e) => !e.withdrawn && e.captain)
        .map((e) => (
          <MyTeamCard key={e.id} t={t} league={x} entry={e} post={post} />
        ))}

      {x.standings.length > 0 && (
        <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("tml.table")}</h2>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th scope="col" className="pr-2">
                  #
                </th>
                <th scope="col">{t("tml.col.team")}</th>
                <th scope="col">{t("tml.col.p")}</th>
                <th scope="col">{t("tml.col.w")}</th>
                <th scope="col">{t("tml.col.d")}</th>
                <th scope="col">{t("tml.col.l")}</th>
                <th scope="col">{t("tml.col.for")}</th>
                <th scope="col">{t("tml.col.against")}</th>
                <th scope="col">{t("tml.col.pts")}</th>
              </tr>
            </thead>
            <tbody>
              {x.standings.map((s) => (
                <tr key={s.leagueTeamId} className={`border-t border-slate-100 ${s.withdrawn ? "text-slate-400" : ""}`}>
                  <td className="py-1 pr-2">{s.position}</td>
                  <td>
                    {s.name}
                    {s.withdrawn && ` (${t("tml.withdrawn")})`}
                  </td>
                  <td>{s.played}</td>
                  <td>{s.won}</td>
                  <td>{s.drawn}</td>
                  <td>{s.lost}</td>
                  <td>{s.pointsFor}</td>
                  <td>{s.pointsAgainst}</td>
                  <td className="font-semibold">{s.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">{t("tml.tableNote")}</p>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{t("tml.fixtures")}</h2>
          {x.entered.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              {t("tml.byTeam")}
              <select value={filter} onChange={(e) => setFilter(e.target.value)} className={input} name="teamFilter">
                <option value="">{t("tml.allTeams")}</option>
                {x.entered.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {x.fixtures.length === 0 ? (
          <p className="text-sm text-slate-500">{t("tml.noFixtures")}</p>
        ) : (
          nights.map((date) => {
            const here = fixtures.filter((f) => f.date === date);
            const playing = new Set(here.flatMap((f) => [f.home.id, f.away.id]));
            const resting = x.entered.filter((e) => !e.withdrawn && !playing.has(e.id) && (!filter || e.id === Number(filter)));
            return (
              <div key={date} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-sm font-semibold">{t("tml.night", { n: here[0].nightNo ?? "–", date })}</h3>
                <ul className="mt-2 divide-y divide-slate-100">
                  {here.map((f) => (
                    <FixtureRow key={f.id} t={t} league={x} f={f} roster={rosterOf(x, f)} mine={myCaptain} enteredIds={enteredIds} post={post} />
                  ))}
                </ul>
                {resting.length > 0 && <p className="mt-2 text-xs text-slate-500">{t("tml.resting", { teams: resting.map((r) => r.name).join(", ") })}</p>}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}

/** The roster of the viewer's side of a fixture, if they captain one: who can be picked for a lineup. */
function rosterOf(x: TeamLeagueDetail, f: FixtureView): RosterMember[] {
  if (!f.mine) return [];
  const entry = x.entered.find((e) => e.id === f.mine!.leagueTeamId);
  return (entry?.roster ?? []).filter((r) => r.memberId !== null).map((r) => ({ id: r.memberId!, name: r.name || null, junior: r.junior, role: "" }));
}

function EnterForm({ t, league, teams, post }: { t: T; league: TeamLeagueDetail; teams: Captained[]; post: (b: object) => Promise<boolean> }) {
  const [teamId, setTeamId] = useState(String(teams[0]?.id ?? ""));
  const [members, setMembers] = useState<{ id: number; name: string | null; junior: boolean }[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [home, setHome] = useState("");
  const [blackouts, setBlackouts] = useState("");
  useEffect(() => {
    if (!teamId) return;
    void fetch(`/api/teams/${teamId}`, { cache: "no-store" })
      .then((r) => readJson(r))
      .then((d: { team?: { roster?: { id: number; name: string | null; junior: boolean }[] } }) => {
        setMembers(d.team?.roster ?? []);
        setPicked([]);
      });
  }, [teamId]);
  return (
    <form
      className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void post({
          action: "enter",
          teamId: Number(teamId),
          memberIds: picked,
          homeCourtId: home ? Number(home) : undefined,
          blackouts: blackouts.split(/[\s,]+/).filter(Boolean),
        });
      }}
    >
      <h2 className="font-semibold">{t("tml.enter")}</h2>
      <label className="flex flex-col text-xs text-slate-500">
        {t("tml.team")}
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className={input} name="enterTeam">
          {teams.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className="text-xs text-slate-500">{t("tml.enterPick", { min: league.rosterMin, max: league.rosterMax })}</legend>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2">
              <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((p) => p !== m.id))} />
              {m.name ?? t("tm.ui.junior")}
            </label>
          ))}
        </div>
      </fieldset>
      {league.courts.length > 1 && (
        <label className="flex flex-col text-xs text-slate-500">
          {t("tml.homeCourt")}
          <select value={home} onChange={(e) => setHome(e.target.value)} className={input} name="homeCourt">
            <option value="">{t("tml.noHome")}</option>
            {league.courts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col text-xs text-slate-500">
        {t("tml.blackouts")}
        <textarea rows={2} value={blackouts} onChange={(e) => setBlackouts(e.target.value)} placeholder="2026-12-01" className={input} name="blackouts" />
      </label>
      <p className="text-xs text-slate-500">{t("tml.enterNote")}</p>
      <button className={primary}>{t("tml.enterButton")}</button>
    </form>
  );
}

/** A captain's own team in the league: its roster and the dates it cannot play, and withdrawing it. */
function MyTeamCard({ t, league, entry, post }: { t: T; league: TeamLeagueDetail; entry: TeamLeagueDetail["entered"][number]; post: (b: object) => Promise<boolean> }) {
  const [dates, setDates] = useState((entry.blackouts ?? []).join("\n"));
  const [members, setMembers] = useState<{ id: number; name: string | null }[]>([]);
  const [picked, setPicked] = useState<number[]>((entry.roster ?? []).filter((r) => r.memberId !== null).map((r) => r.memberId!));
  useEffect(() => {
    if (!entry.teamId) return;
    void fetch(`/api/teams/${entry.teamId}`, { cache: "no-store" })
      .then((r) => readJson(r))
      .then((d: { team?: { roster?: { id: number; name: string | null }[] } }) => setMembers(d.team?.roster ?? []));
  }, [entry.teamId]);
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h2 className="font-semibold">{t("tml.mine", { team: entry.name })}</h2>
      {league.status !== "finished" && league.status !== "closed" && (
        <>
          <fieldset>
            <legend className="text-xs text-slate-500">{t("tml.enterPick", { min: league.rosterMin, max: league.rosterMax })}</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {members.map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((p) => p !== m.id))} />
                  {m.name ?? t("tm.ui.junior")}
                </label>
              ))}
            </div>
            <button className={`${small} mt-2`} onClick={() => void post({ action: "roster", leagueTeamId: entry.id, memberIds: picked })}>
              {t("tml.saveRoster")}
            </button>
          </fieldset>
          <label className="flex flex-col text-xs text-slate-500">
            {t("tml.blackouts")}
            <textarea rows={2} value={dates} onChange={(e) => setDates(e.target.value)} className={input} name={`blackouts${entry.id}`} />
          </label>
          <div className="space-x-2">
            <button className={small} onClick={() => void post({ action: "blackouts", leagueTeamId: entry.id, dates: dates.split(/[\s,]+/).filter(Boolean) })}>
              {t("tml.saveBlackouts")}
            </button>
            <button className={small} onClick={() => void post({ action: "withdraw", leagueTeamId: entry.id })}>
              {t("tml.withdrawTeam")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function FixtureRow({
  t,
  league,
  f,
  roster,
  mine,
  enteredIds,
  post,
}: {
  t: T;
  league: TeamLeagueDetail;
  f: FixtureView;
  roster: RosterMember[];
  mine: number[];
  enteredIds: Set<number>;
  post: (b: object) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const captainHere = f.mine !== undefined && mine.includes(f.mine.leagueTeamId);
  const status = {
    scheduled: t("tml.fixture.scheduled"),
    reported: t("tml.fixture.reported"),
    confirmed: t("tml.fixture.confirmed"),
    disputed: t("tml.fixture.disputed"),
    forfeit: t("tml.fixture.forfeit", { team: f.forfeitBy === f.home.id ? f.home.name : f.away.name }),
    void: t("tml.fixture.void"),
  }[f.status];
  const score = f.result && f.status !== "void" ? (f.result.winner === "draw" ? `${f.result.score ?? `${f.result.home}-${f.result.away}`}` : (f.result.score ?? `${f.result.home}-${f.result.away}`)) : null;
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong className={enteredIds.has(f.home.id) ? "" : "text-slate-400"}>{f.home.name}</strong> {t("tml.v")} <strong className={enteredIds.has(f.away.id) ? "" : "text-slate-400"}>{f.away.name}</strong>
          {score && <span className="ml-2 font-mono">{score}</span>}
        </span>
        <span className="text-xs text-slate-500">
          {formatMinute(f.startMin)}
          {f.courtName && ` · ${f.courtName}`} · {status}
        </span>
      </div>
      {(f.rubbers.some((r) => r.played) || f.lineup || captainHere) && (
        <button className="mt-1 text-xs text-teal-700 underline" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? t("tml.hideGames") : t("tml.showGames")}
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-3 rounded-lg bg-slate-50 p-3">
          <ul className="space-y-1">
            {f.rubbers.map((r, i) => (
              <li key={r.no}>
                <span className="font-medium">{gameLabel(t, league.rubbers, i)}</span>
                {r.played && ` · ${r.walkover ? t("tml.walkoverTo", { team: r.winner === "home" ? f.home.name : f.away.name }) : `${r.score ?? ""} ${r.winner === null ? t("tml.drawn") : ""}`}`}
                {f.lineup && (
                  <span className="text-slate-500">
                    {" "}
                    · {(["home", "away"] as const)
                      .map((side) => {
                        const names = f.lineup!.filter((l) => l.rubber === r.no && l.side === side).map((l) => l.name || t("tm.ui.junior"));
                        return names.length ? `${side === "home" ? f.home.name : f.away.name}: ${names.join(" / ")}` : null;
                      })
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {f.status === "scheduled" && captainHere && roster.length > 0 && <LineupForm t={t} league={league} f={f} roster={roster} post={post} />}
          {f.status === "disputed" && f.disputeNote && <p className="text-xs text-slate-600">{t("tml.disputeNote", { note: f.disputeNote })}</p>}
        </div>
      )}
      {captainHere && f.mine && (f.status === "scheduled" || (f.status === "reported" && f.reportedBy === f.mine.leagueTeamId)) && (
        <ReportForm t={t} league={league} f={f} post={post} />
      )}
      {captainHere && f.mine && f.status === "reported" && f.reportedBy !== f.mine.leagueTeamId && <AnswerForm t={t} f={f} post={post} />}
    </li>
  );
}

function LineupForm({ t, league, f, roster, post }: { t: T; league: TeamLeagueDetail; f: FixtureView; roster: RosterMember[]; post: (b: object) => Promise<boolean> }) {
  const side = f.mine!.side;
  const size = (kind: string) => (kind === "singles" ? 1 : kind === "doubles" ? 2 : 0);
  const [picks, setPicks] = useState<number[][]>(() =>
    league.rubbers.map((_, i) => {
      return (f.lineup ?? []).filter((l) => l.rubber === i + 1 && l.side === side && l.memberId !== null).map((l) => l.memberId!);
    })
  );
  const set = (i: number, j: number, v: number | null) => {
    const next = picks.map((p) => [...p]);
    if (v === null) next[i].splice(j, 1);
    else next[i][j] = v;
    setPicks(next.map((p) => p.filter((x) => x !== undefined)));
  };
  return (
    <form
      className="space-y-2 border-t border-slate-200 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        void post({ action: "lineup", fixtureId: f.id, picks: picks.map((memberIds, i) => ({ rubber: i + 1, memberIds })) });
      }}
    >
      <h4 className="text-xs font-semibold">{t("tml.lineup")}</h4>
      {league.rubbers.map((kind, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="w-24 text-slate-500">{gameLabel(t, league.rubbers, i)}</span>
          {kind === "team" ? (
            <span className="flex flex-wrap gap-2">
              {roster.map((r) => (
                <label key={r.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={picks[i].includes(r.id)} onChange={(e) => setPicks(picks.map((p, k) => (k === i ? (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)) : p)))} />
                  {r.name ?? t("tm.ui.junior")}
                </label>
              ))}
            </span>
          ) : (
            Array.from({ length: size(kind) }, (_, j) => (
              <select key={j} value={picks[i][j] ?? ""} onChange={(e) => set(i, j, e.target.value ? Number(e.target.value) : null)} className={input} aria-label={`${gameLabel(t, league.rubbers, i)} ${j + 1}`}>
                <option value="" />
                {roster.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name ?? t("tm.ui.junior")}
                  </option>
                ))}
              </select>
            ))
          )}
        </div>
      ))}
      <button className={small}>{t("tml.saveLineup")}</button>
    </form>
  );
}

function ReportForm({ t, league, f, post }: { t: T; league: TeamLeagueDetail; f: FixtureView; post: (b: object) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const drawsOk = league.rules.scoring.kind === "tally" && league.rules.scoring.draws;
  const [rows, setRows] = useState(() => league.rubbers.map(() => ({ winner: "", score: "", walkover: false })));
  if (!open)
    return (
      <button className={`${small} mt-2`} onClick={() => setOpen(true)}>
        {t("tml.report")}
      </button>
    );
  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-slate-200 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void post({
          action: "report",
          fixtureId: f.id,
          version: f.version,
          rubbers: rows.map((r) => ({ winner: r.winner === "draw" || r.winner === "" ? null : r.winner, score: r.walkover ? undefined : r.score, walkover: r.walkover })),
        }).then((ok) => ok && setOpen(false));
      }}
    >
      <p className="text-xs text-slate-500">{t("tml.scoreHint", { home: f.home.name })}</p>
      {league.rubbers.map((_, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="w-24 text-slate-500">{gameLabel(t, league.rubbers, i)}</span>
          <select
            value={rows[i].winner}
            onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, winner: e.target.value } : r)))}
            className={input}
            aria-label={`${gameLabel(t, league.rubbers, i)}: ${t("tml.winner")}`}
          >
            <option value="">{drawsOk ? t("tml.draw") : t("tml.winner")}</option>
            <option value="home">{f.home.name}</option>
            <option value="away">{f.away.name}</option>
          </select>
          <input
            value={rows[i].score}
            disabled={rows[i].walkover}
            onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, score: e.target.value } : r)))}
            placeholder={league.rules.scoring.kind === "tally" ? "3-2" : "21-15, 18-21, 21-10"}
            className={`w-48 ${input}`}
            aria-label={`${gameLabel(t, league.rubbers, i)}: ${t("tml.score")}`}
          />
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={rows[i].walkover} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, walkover: e.target.checked } : r)))} />
            {t("tml.walkover")}
          </label>
        </div>
      ))}
      <button className={small}>{t("tml.sendReport")}</button>
    </form>
  );
}

function AnswerForm({ t, f, post }: { t: T; f: FixtureView; post: (b: object) => Promise<boolean> }) {
  const [note, setNote] = useState("");
  const [disputing, setDisputing] = useState(false);
  const reporter = f.reportedBy === f.home.id ? f.home.name : f.away.name;
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
      <p>{t("tml.reportedBy", { team: reporter, days: 3 })}</p>
      <div className="space-x-2">
        <button className={small} onClick={() => void post({ action: "confirm", fixtureId: f.id, version: f.version })}>
          {t("tml.confirm")}
        </button>
        <button className={small} onClick={() => setDisputing(!disputing)}>
          {t("tml.dispute")}
        </button>
      </div>
      {disputing && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void post({ action: "dispute", fixtureId: f.id, note, version: f.version });
          }}
        >
          <input required minLength={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("tml.disputeWhat")} aria-label={t("tml.disputeWhat")} className={`min-w-0 flex-1 ${input}`} />
          <button className={small}>{t("tml.sendDispute")}</button>
        </form>
      )}
    </div>
  );
}
