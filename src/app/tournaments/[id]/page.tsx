"use client";

import { readJson } from "@/lib/read-response";
import { ActivityGlyph } from "@/components/Glyph";
import { accountDetour } from "@/lib/phone-detour";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { TeamEntry } from "@/components/TeamEntry";
import { translateError } from "@/lib/i18n";
import type { Phrase, T } from "@/lib/i18n";
import { formatMinute } from "@/lib/interval";

import type { Entry, Match, TournamentDetail } from "@/lib/tournaments";
import type { MatchReport } from "@/lib/match-reports";
import { MatchResultForm } from "@/components/MatchResultForm";
import { SwissStandings } from "@/components/SwissStandings";
import { resultSentence, scoreExample } from "@/lib/result-text";

/**
 * One tournament, for anybody: what it is, who has entered, and once the
 * draw is made the groups, the bracket and when everybody plays — kept up to
 * date while it is on. Signed in, a player enters, pays and withdraws here.
 */
export default function TournamentPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{
    tournament: TournamentDetail;
    mine: Entry | null;
    /** Entries this account made for people it acts for, and those people. */
    managed?: Entry[];
    people?: { id: number; name: string }[];
    signedIn: boolean;
    reports?: MatchReport[];
  } | null>(null);
  const [missing, setMissing] = useState(false);
  const [partner, setPartner] = useState("");
  const [partnerGender, setPartnerGender] = useState<"woman" | "man" | "">("");
  const [who, setWho] = useState<Who>({ id: "", gender: "" });
  const [team, setTeam] = useState<TeamForm>({ name: "", roster: "", mark: "", birth: "", partnerBirth: "", rosterOk: false, guardian: "", guardianOk: false });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/tournaments/${id}`, { cache: "no-store" });
    if (!res.ok) return setMissing(true);
    setData(await readJson(res));
  }, [id]);
  useEffect(() => {
    void load();
    // Results come in while it is on.
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(body: object) {
    setError(null);
    const res = await fetch(`/api/tournaments/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await readJson(res);
    if (!res.ok && accountDetour(out)) return;
    if (!res.ok) return setError(translateError(t, out) || out.error);
    if (out.url) {
      window.location.href = out.url;
      return;
    }
    await load();
  }

  if (missing) return <p className="text-slate-500">{t("tour.none")}</p>;
  if (!data) return null;
  const x = data.tournament;
  const names = new Map(x.entries.map((e) => [e.id, e.name]));
  const final = x.matches.filter((m) => m.stage === "knockout").sort((a, b) => b.round - a.round)[0];
  const underReview = x.issues.some((i) => i.status === "open");
  // The winner: the knockout's final, the round robin's table, or the best performance.
  const winnerId =
    x.status !== "finished" || underReview
      ? null
      : x.format === "performance"
        ? x.performance?.ranking.find((r) => r.rank === 1)?.entryId ?? null
        : x.format === "round_robin"
          ? x.groups[0]?.table.find((r) => !r.out)?.entryId ?? null
          : x.format === "swiss"
            ? x.swiss?.standings.find((l) => l.rank === 1)?.entryId ?? null
            : final?.winner ?? null;
  const champion = winnerId !== null ? names.get(winnerId) : null;
  const tally = x.rules.scoring.kind === "tally";
  const byPoints = x.rules.scoring.rankBy.includes("points");
  const formatLabel = x.format === "groups" ? t("tour.groups") : x.format === "round_robin" ? t("tour.roundRobin") : x.format === "performance" ? t("tour.performance") : x.format === "swiss" ? t("tour.swiss") : t("tour.knockout");
  // The side of a match this account answers for: its own entry, or one it made for somebody it acts for (never both).
  const ours = new Set([...(data.mine ? [data.mine.id] : []), ...(data.managed ?? []).map((e) => e.id)]);
  const ourSide = (m: Match): number | null => {
    const a = m.a !== null && ours.has(m.a);
    const b = m.b !== null && ours.has(m.b);
    return a && b ? null : a ? m.a : b ? m.b : null;
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/tournaments" className="text-sm text-teal-700 underline">
          ← {t("tour.title")}
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          <ActivityGlyph sport={x.sport} /> {x.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          <Link href={`/venue/${x.venueId}`} className="underline">
            {x.venueName}
          </Link>{" "}
          · {t("tour.when", { from: x.startsOn, to: x.endsOn, start: formatMinute(x.startMin, t.locale), end: formatMinute(x.endMin, t.locale) })}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {x.category !== "open" && `${t(`cat.${x.category}`)} · `}
          {x.entryKind === "team" ? t("tour.teams") : x.teamSize === 2 ? t("tour.doubles") : t("tour.singles")} · {formatLabel}
          {x.level && ` · ${t(`games.level.${x.level}`)}`} · {x.entryFee > 0 ? t("tour.fee", { amount: x.entryFee.toFixed(2) }) : t("tour.free")} ·{" "}
          {t(`tour.status.${x.status}`)}
        </p>
        {x.competition && <p className="mt-1 text-sm font-medium text-slate-700">{t("tour.division", { name: x.competition.name })}</p>}
        {eligibilityLine(t, x) && <p className="mt-1 text-sm text-slate-600">{eligibilityLine(t, x)}</p>}
        {x.description && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{x.description}</p>}
        {x.rated && <p className="mt-2 text-sm text-slate-600">{t("rt.ratedNote")}</p>}
        {champion && <p className="mt-3 text-lg font-bold text-teal-700">🏆 {t("tour.champion", { name: champion })}</p>}
        {x.status === "drawn" && x.format !== "performance" && (
          <p className="mt-2">
            <Link href={`/tournaments/${x.id}/live`} className="text-sm font-medium text-teal-700 underline">
              {t("dy1.live.link")}
            </Link>
          </p>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      <EnterBox
        t={t}
        x={x}
        mine={data.mine}
        managed={data.managed ?? []}
        people={data.people ?? []}
        who={who}
        setWho={setWho}
        signedIn={data.signedIn}
        partner={partner}
        setPartner={setPartner}
        partnerGender={partnerGender}
        setPartnerGender={setPartnerGender}
        team={team}
        setTeam={setTeam}
        act={act}
      />

      {underReview && <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">{t("tour.underReview")}</p>}
      {x.corrections.length > 0 && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t("tour.corrected")}</p>}

      {x.performance && <Performances t={t} x={x} names={names} />}

      {x.swiss && <SwissStandings t={t} x={x} names={names} />}

      {x.groups.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {x.groups.map((g) => (
            <div key={g.groupNo} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="font-semibold">{t("tour.group", { n: g.groupNo })}</h2>
              <table className="mt-2 w-full text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium" />
                    <th className="w-8 font-medium">{t("tour.played")}</th>
                    <th className="w-8 font-medium">{t("tour.won")}</th>
                    {tally && <th className="w-8 font-medium">{t("tour.drawnShort")}</th>}
                    <th className="w-8 font-medium">{t("tour.lost")}</th>
                    <th className="w-12 font-medium">{tally ? t("tour.diff") : t("tour.sets")}</th>
                    {byPoints && <th className="w-10 font-medium">{t("tour.points")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {g.table.map((s) => (
                    // Who is out is shown where their results put them, never as going through.
                    <tr
                      key={s.entryId}
                      className={s.out ? "text-slate-400" : g.table.filter((r) => !r.out).indexOf(s) < x.advance ? "font-medium" : "text-slate-600"}
                    >
                      <td className="py-0.5">
                        {names.get(s.entryId)}
                        {s.out && (
                          <span className="ml-1 text-xs">
                            ({t(`tour.out.${s.out}`)}
                            {s.resultsVoid ? `, ${t("tour.resultsVoid")}` : ""})
                          </span>
                        )}
                      </td>
                      <td className="text-center">{s.played}</td>
                      <td className="text-center">{s.won}</td>
                      {tally && <td className="text-center">{s.drawn}</td>}
                      <td className="text-center">{s.lost}</td>
                      <td className="text-center">
                        {(tally ? s.pointDiff : s.setDiff) > 0 ? "+" : ""}
                        {tally ? s.pointDiff : s.setDiff}
                      </td>
                      {byPoints && <td className="text-center font-medium">{s.points}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      {x.matches.some((m) => m.stage === "knockout") && <Bracket t={t} matches={x.matches.filter((m) => m.stage === "knockout")} names={names} />}

      {x.matches.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("tour.matches")}</h2>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {x.matches
              .filter((m) => m.status !== "bye" && m.date && (m.stage === "group" || m.stage === "knockout"))
              .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.minute ?? 0) - (b.minute ?? 0))
              .map((m) => (
                <li key={m.id} className="flex flex-wrap gap-x-3 py-1.5">
                  <span className="w-36 shrink-0 text-slate-500">
                    {x.swiss && `${t("swiss.ui.round", { n: m.round })} · `}
                    {m.date} {formatMinute(m.minute!, t.locale)}, {m.courtName}
                  </span>
                  <span className="flex-1">
                    <Side id={m.a} m={m} names={names} t={t} /> v <Side id={m.b} m={m} names={names} t={t} />
                  </span>
                  <span className="text-slate-600">
                    {m.status === "walkover"
                      ? t("tour.walkover")
                      : m.status === "retired"
                        ? `${m.score ?? ""} (${t("tour.retired")})`
                        : m.status === "done" && m.winner === null
                          ? `${m.score ?? ""} (${t("tour.drawn")})`
                          : m.score}
                  </span>
                  {x.resultsBy === "players" && ourSide(m) !== null && m.status === "scheduled" && m.a !== null && m.b !== null && (
                    <MyResult t={t} x={x} m={m} mine={ourSide(m)!} names={names} report={(data.reports ?? []).find((r) => r.matchId === m.id) ?? null} act={act} />
                  )}
                </li>
              ))}
          </ul>
        </section>
      )}

      {x.matches.length === 0 && x.entries.some((e) => e.status === "entered") && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("tour.entriesTitle")}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {t("tour.entries", { entered: x.entered, max: x.maxEntries })}
            {x.waitlisted > 0 && ` · ${t("tour.waiting", { n: x.waitlisted })}`}
          </p>
          <ul className="mt-2 columns-2 text-sm">
            {x.entries
              .filter((e) => e.status === "entered")
              .map((e) => (
                <li key={e.id}>{e.name}</li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The player's own match, where players enter results: report it; or, the
 * other side having reported it, confirm it or say it is wrong.
 */
function MyResult({
  t,
  x,
  m,
  mine,
  names,
  report,
  act,
}: {
  t: T;
  x: TournamentDetail;
  m: Match;
  mine: number;
  names: Map<number, string>;
  report: MatchReport | null;
  act: (body: object) => Promise<void>;
}) {
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  const button = "rounded-md px-2.5 py-1 text-xs font-semibold";
  if (report?.status === "disputed") return <p className="w-full text-xs text-amber-800">{t("result.disputed")}</p>;
  if (report && report.entryId === mine) return <p className="w-full text-xs text-slate-500">{t("result.waiting", { result: resultSentence(t, report, names) })}</p>;
  if (report)
    return (
      <div className="w-full text-xs">
        <span className="text-slate-700">{t("result.theyReported", { result: resultSentence(t, report, names) })}</span>{" "}
        <button onClick={() => void act({ action: "confirm", matchId: m.id })} className={`${button} bg-teal-600 text-white`}>
          {t("result.confirm")}
        </button>{" "}
        {disputing ? (
          <span className="inline-flex gap-1">
            <input aria-label={t("result.disputeNote")} placeholder={t("result.disputeNote")} value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1" />
            <button onClick={() => void act({ action: "dispute", matchId: m.id, note })} className={`${button} border border-amber-400 text-amber-900`}>
              {t("result.dispute")}
            </button>
          </span>
        ) : (
          <button onClick={() => setDisputing(true)} className={`${button} border border-slate-300 text-slate-700`}>
            {t("result.dispute")}
          </button>
        )}
      </div>
    );
  return (
    <div className="w-full">
      <span className="text-xs font-medium text-slate-600">{t("result.report")}</span>
      <MatchResultForm
        t={t}
        // The player's own side first: they write their own score first.
        sides={
          m.a === mine
            ? { a: { id: m.a!, name: names.get(m.a!) ?? "" }, b: { id: m.b!, name: names.get(m.b!) ?? "" } }
            : { a: { id: m.b!, name: names.get(m.b!) ?? "" }, b: { id: m.a!, name: names.get(m.a!) ?? "" } }
        }
        drawAllowed={x.rules.scoring.kind === "tally" && x.rules.scoring.draws && m.stage === "group"}
        scoreHint={scoreExample(x)}
        onSubmit={(r) => act({ action: "report", matchId: m.id, ...r })}
      />
    </div>
  );
}

/** A performance event: every heat and the final, lane by lane, and the overall placings. */
function Performances({ t, x, names }: { t: T; x: TournamentDetail; names: Map<number, string> }) {
  const p = x.performance!;
  const status = (s: string) => (s === "dns" ? t("tour.dns") : s === "dnf" ? t("tour.dnf") : s === "dq" ? t("tour.dq") : t("tour.pending"));
  const units = x.matches.filter((m) => m.stage === "heat" || m.stage === "final").sort((a, b) => (a.stage === "final" ? 1 : 0) - (b.stage === "final" ? 1 : 0) || a.position - b.position);
  return (
    <section className="space-y-3">
      {p.ranking.some((r) => r.rank !== null) && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">{t("tour.results")}</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="w-12 text-left font-medium">{t("tour.rank")}</th>
                <th className="text-left font-medium" />
                <th className="text-right font-medium">{t("tour.mark")}</th>
              </tr>
            </thead>
            <tbody>
              {p.ranking.map((r) => (
                <tr key={r.entryId} className={r.rank === null ? "text-slate-400" : ""}>
                  <td>{r.rank ?? "—"}</td>
                  <td>{names.get(r.entryId)}</td>
                  <td className="text-right">{r.shown ?? status(r.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {units.map((m) => (
          <div key={m.id} className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <h3 className="font-semibold">
              {m.stage === "final" ? t("tour.final") : t("tour.heat", { n: m.position })}
              <span className="ml-2 text-xs font-normal text-slate-500">
                {m.date} {m.minute !== null && formatMinute(m.minute, t.locale)}, {m.courtName}
              </span>
            </h3>
            <table className="mt-1 w-full">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="w-12 text-left font-medium">{t("tour.lane")}</th>
                  <th className="text-left font-medium" />
                  <th className="text-right font-medium">{t("tour.mark")}</th>
                </tr>
              </thead>
              <tbody>
                {(p.lines[m.id] ?? [])
                  .slice()
                  .sort((a, b) => a.lane - b.lane)
                  .map((l) => (
                    <tr key={l.entryId}>
                      <td>{l.lane}</td>
                      <td>{names.get(l.entryId)}</td>
                      <td className="text-right">{l.shown ?? status(l.status)}{l.rank !== null && <span className="ml-1 text-xs text-slate-400">({l.rank})</span>}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

function Side({ id, m, names, t }: { id: number | null; m: Match; names: Map<number, string>; t: T }) {
  if (id === null) return <span className="text-slate-400">{t("tour.tbd")}</span>;
  return <span className={m.winner === id ? "font-semibold" : ""}>{names.get(id)}</span>;
}

function roundName(t: T, round: number, rounds: number): string {
  if (round === rounds) return t("tour.final");
  if (round === rounds - 1) return t("tour.semis");
  if (round === rounds - 2) return t("tour.quarters");
  return t("tour.round", { n: round });
}

/** The knockout, a column a round. */
function Bracket({ t, matches, names }: { t: T; matches: Match[]; names: Map<number, string> }) {
  const rounds = Math.max(...matches.map((m) => m.round));
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="font-semibold">{t("tour.knockoutTitle")}</h2>
      <div className="mt-3 flex gap-4 overflow-x-auto pb-2">
        {Array.from({ length: rounds }, (_, i) => i + 1).map((round) => (
          <div key={round} className="flex min-w-[11rem] flex-col justify-around gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{roundName(t, round, rounds)}</div>
            {matches
              .filter((m) => m.round === round)
              .sort((a, b) => (a.placement ?? 0) - (b.placement ?? 0) || a.position - b.position)
              .map((m) => (
                <div key={m.id} className="rounded-lg border border-slate-200 text-sm">
                  {m.placement === 3 && <div className="px-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("tour.thirdPlace")}</div>}
                  {[m.a, m.b].map((side, i) => (
                    <div
                      key={i}
                      className={`flex justify-between gap-2 px-2 py-1 ${i === 0 ? "border-b border-slate-100" : ""} ${
                        side !== null && m.winner === side ? "bg-teal-50 font-semibold" : ""
                      }`}
                    >
                      <span className="truncate">{side === null ? (m.status === "bye" ? t("tour.bye") : t("tour.tbd")) : names.get(side)}</span>
                    </div>
                  ))}
                  {(m.score || m.status === "walkover" || m.status === "retired") && (
                    <div className="px-2 pb-1 text-xs text-slate-500">
                      {m.status === "walkover" ? t("tour.walkover") : m.status === "retired" ? `${m.score ?? ""} (${t("tour.retired")})` : m.score}
                    </div>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** What the entry form holds besides a partner: a team, an entry mark, and the dates of birth an age range asks for. */
interface TeamForm {
  name: string;
  roster: string;
  mark: string;
  birth: string;
  partnerBirth: string;
  rosterOk: boolean;
  guardian: string;
  guardianOk: boolean;
}

/** Under 18 on the first day, by a declared date of birth (the server checks it again). */
function minorOn(birth: string, day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return false;
  const [by, bm, bd] = birth.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0) < 18;
}

/** Who may enter, as a line: ages on the first day, members only, the last day for entries. */
function eligibilityLine(t: T, x: TournamentDetail): string {
  const parts: string[] = [];
  if (x.ageRange) {
    const { min, max } = x.ageRange;
    const ages = min !== null && max !== null ? t("tour.agesBetween", { min, max }) : min !== null ? t("tour.agesOver", { min }) : t("tour.agesUnder", { max: max ?? 0 });
    parts.push(t("tour.agesOn", { ages, date: x.startsOn }));
  }
  if (x.membersOnly) parts.push(t("tour.membersOnly"));
  if (x.entriesCloseOn) parts.push(t("tour.entriesClose", { date: x.entriesCloseOn }));
  return parts.join(" · ");
}

/** Who is entering: the account holder (`id` ""), or somebody they act for, with that person's gender as declared. */
interface Who {
  id: string;
  gender: "woman" | "man" | "";
}

/** One entry the account holds, its own or one it made for somebody: its fee, and withdrawing it before the draw. */
function HeldEntry({
  t,
  x,
  e,
  label,
  entryId,
  forName,
  act,
}: {
  t: T;
  x: TournamentDetail;
  e: Entry;
  label: string;
  entryId?: number;
  /** An entry made for somebody the account acts for: their name, so its fee says whose it is. */
  forName?: string;
  act: (body: object) => Promise<void>;
}) {
  const button = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm">
      <span className="font-medium text-teal-900">{label}</span>
      <span className="flex flex-wrap items-center gap-3">
        {/* The fee as it was when this entry was made: a later change is for new entries. */}
        {e.status === "entered" && (e.fee ?? x.entryFee) > 0 &&
          (e.paid ? (
            <span className="font-semibold text-emerald-700">{t("tour.feePaid")}</span>
          ) : x.payOnline ? (
            <button onClick={() => void act({ action: "pay", ...(entryId ? { entryId } : {}) })} className={button}>
              {forName ? t("fin5.tour.payFeeFor", { name: forName, amount: (e.fee ?? x.entryFee).toFixed(2) }) : t("tour.payFee", { amount: (e.fee ?? x.entryFee).toFixed(2) })}
            </button>
          ) : (
            <span>{t("tour.payAtVenue", { amount: (e.fee ?? x.entryFee).toFixed(2) })}</span>
          ))}
        {(x.status === "open" || x.status === "closed") && (
          <button onClick={() => void act({ action: "withdraw", ...(entryId ? { entryId } : {}) })} className="text-slate-600 underline">
            {t("tour.withdraw")}
          </button>
        )}
      </span>
    </section>
  );
}

function EnterBox({
  t,
  x,
  mine,
  managed,
  people,
  who,
  setWho,
  signedIn,
  partner,
  setPartner,
  partnerGender,
  setPartnerGender,
  team,
  setTeam,
  act,
}: {
  t: T;
  x: TournamentDetail;
  mine: Entry | null;
  managed: Entry[];
  people: { id: number; name: string }[];
  who: Who;
  setWho: (w: Who) => void;
  signedIn: boolean;
  partner: string;
  setPartner: (p: string) => void;
  partnerGender: "woman" | "man" | "";
  setPartnerGender: (g: "woman" | "man" | "") => void;
  team: TeamForm;
  setTeam: (v: TeamForm) => void;
  act: (body: object) => Promise<void>;
}) {
  const button = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";
  const held = (
    <>
      {mine && <HeldEntry t={t} x={x} e={mine} label={`${mine.status === "waitlisted" ? t("tour.youWait") : t("tour.youreIn")}: ${mine.name}`} act={act} />}
      {managed.map((e) => (
        <HeldEntry
          key={e.id}
          t={t}
          x={x}
          e={e}
          entryId={e.id}
          forName={people.find((p) => p.id === e.participantId)?.name ?? e.name}
          label={t(e.status === "waitlisted" ? "lg5.waiting" : "lg5.entered", { name: e.name })}
          act={act}
        />
      ))}
    </>
  );
  if (x.status !== "open") return held;
  if (!signedIn)
    return (
      <Link href={`/login?next=/tournaments/${x.id}`} className={`inline-block ${button}`}>
        {t("tour.signInToEnter")}
      </Link>
    );
  // Who may still be entered: the account holder, unless entered, and each person they act for who is not.
  const enteredFor = new Set(managed.map((e) => e.participantId));
  const choices = [...(mine ? [] : [{ id: "", name: t("lg5.myself") }]), ...people.filter((p) => !enteredFor.has(p.id)).map((p) => ({ id: String(p.id), name: p.name }))];
  if (choices.length === 0) return held;
  const chosen = choices.some((c) => c.id === who.id) ? who.id : choices[0].id;
  const forOther = chosen !== "";
  // Entering somebody they act for: the form asks about that person by name, not "your".
  const theirName = forOther ? (choices.find((c) => c.id === chosen)?.name ?? "") : null;
  const label = (own: Phrase, of: Phrase) => (theirName ? t(of, { name: theirName }) : t(own));
  // A declared minor (or a team event for under-18s) enters with a parent or guardian's agreement.
  const minors =
    !!x.ageRange &&
    (minorOn(team.birth, x.startsOn) || (x.teamSize === 2 && minorOn(team.partnerBirth, x.startsOn)) || (x.entryKind === "team" && x.ageRange.max !== null && x.ageRange.max < 18));
  return (
    <>
    {held}
    {x.entryKind === "team" && !forOther && !mine && <TeamEntry t={t} sport={x.sport} roster={x.roster} act={act} />}
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // In a women's or men's doubles the partner is the same as the event; in mixed, the entrant says.
        const pg = x.category === "women" ? "woman" : x.category === "men" ? "man" : partnerGender || undefined;
        void act({
          action: "enter",
          // Somebody the account acts for: they are the entrant, their gender as declared here.
          ...(forOther ? { participantId: Number(chosen), ...(x.category !== "open" ? { gender: who.gender || undefined } : {}) } : {}),
          partnerName: partner,
          partnerGender: pg,
          ...(x.entryKind === "team" ? { teamName: team.name, roster: team.roster.split("\n").map((n) => n.trim()).filter(Boolean) } : {}),
          ...(x.format === "performance" && team.mark.trim() ? { entryMark: team.mark.trim() } : {}),
          ...(x.ageRange
            ? { birthDate: team.birth, ...(x.teamSize === 2 ? { partnerBirthDate: team.partnerBirth } : {}), ...(x.entryKind === "team" ? { rosterEligible: team.rosterOk } : {}) }
            : {}),
          // A guardian entering somebody they act for gives the agreement themself, under their own name.
          ...(minors ? { guardianName: forOther ? undefined : team.guardian, guardianConsent: team.guardianOk } : {}),
        });
      }}
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      {choices.length > 1 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("lg5.whoEnters")}
          <select
            value={chosen}
            onChange={(e) => setWho({ ...who, id: e.target.value })}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          >
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {forOther && x.category !== "open" && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("lg5.theyAre")}
          <select
            required
            value={who.gender}
            onChange={(e) => setWho({ ...who, id: chosen, gender: e.target.value as Who["gender"] })}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          >
            <option value="">—</option>
            <option value="woman">{t("who.partnerWoman")}</option>
            <option value="man">{t("who.partnerMan")}</option>
          </select>
        </label>
      )}
      {forOther && <p className="w-full text-xs text-slate-500">{t("lg5.forThem")}</p>}
      {x.teamSize === 2 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {label("tour.partner", "fin5.tour.partnerOf")}
          <input
            required
            minLength={2}
            value={partner}
            onChange={(e) => setPartner(e.target.value)}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
      )}
      {x.teamSize === 2 && x.category === "mixed" && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {label("who.partner", "fin5.who.partnerOf")}
          <select
            required
            value={partnerGender}
            onChange={(e) => setPartnerGender(e.target.value as "woman" | "man" | "")}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          >
            <option value="">—</option>
            <option value="woman">{t("who.partnerWoman")}</option>
            <option value="man">{t("who.partnerMan")}</option>
          </select>
        </label>
      )}
      {x.entryKind === "team" && (
        <>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("tour.teamName")}
            <input
              required
              minLength={2}
              value={team.name}
              onChange={(e) => setTeam({ ...team, name: e.target.value })}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
            />
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("tour.roster")}
            {x.roster && <span className="font-normal">{t("tour.rosterSize", { min: x.roster.min, max: x.roster.max })}</span>}
            <textarea
              required
              rows={4}
              value={team.roster}
              onChange={(e) => setTeam({ ...team, roster: e.target.value })}
              className="mt-1 w-64 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
            />
          </label>
        </>
      )}
      {x.format === "performance" && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {label("tour.entryMark", "fin5.tour.entryMarkOf")}
          <input
            value={team.mark}
            onChange={(e) => setTeam({ ...team, mark: e.target.value })}
            placeholder={x.rules.performance?.measure === "time" ? "1:02.35" : "7.42"}
            className="mt-1 w-32 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
      )}
      {x.ageRange && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {label("tour.birthDate", "fin5.tour.birthDateOf")}
          <input
            type="date"
            required
            value={team.birth}
            onChange={(e) => setTeam({ ...team, birth: e.target.value })}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
      )}
      {x.ageRange && x.teamSize === 2 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {label("tour.partnerBirthDate", "fin5.tour.partnerBirthDateOf")}
          <input
            type="date"
            required
            value={team.partnerBirth}
            onChange={(e) => setTeam({ ...team, partnerBirth: e.target.value })}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
      )}
      {x.ageRange && x.entryKind === "team" && (
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" required checked={team.rosterOk} onChange={(e) => setTeam({ ...team, rosterOk: e.target.checked })} />
          {t("tour.rosterEligible", { date: x.startsOn })}
        </label>
      )}
      {minors && (
        <>
          {!forOther && (
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("tour.guardianName")}
              <input
                required
                minLength={2}
                value={team.guardian}
                onChange={(e) => setTeam({ ...team, guardian: e.target.value })}
                className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" required checked={team.guardianOk} onChange={(e) => setTeam({ ...team, guardianOk: e.target.checked })} />
            {t("tour.guardianConsent")}
          </label>
        </>
      )}
      <button className={button}>{t("tour.enter")}</button>
      <span className="text-sm text-slate-500">
        {t("tour.entries", { entered: x.entered, max: x.maxEntries })}
        {x.waitlisted > 0 && ` · ${t("tour.waiting", { n: x.waitlisted })}`}
      </span>
    </form>
    </>
  );
}
