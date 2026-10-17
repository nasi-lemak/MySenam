"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import { formatHour } from "@/lib/time";
import { SPORT_ICONS } from "@/lib/types";
import type { Entry, Match, TournamentDetail } from "@/lib/tournaments";

/**
 * One tournament, for anybody: what it is, who has entered, and once the
 * draw is made the groups, the bracket and when everybody plays — kept up to
 * date while it is on. Signed in, a player enters, pays and withdraws here.
 */
export default function TournamentPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ tournament: TournamentDetail; mine: Entry | null; signedIn: boolean } | null>(null);
  const [missing, setMissing] = useState(false);
  const [partner, setPartner] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/tournaments/${id}`, { cache: "no-store" });
    if (!res.ok) return setMissing(true);
    setData(await res.json());
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
    const out = await res.json();
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
  const champion = x.status === "finished" && final?.winner ? names.get(final.winner) : null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/tournaments" className="text-sm text-teal-700 underline">
          ← {t("tour.title")}
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          {SPORT_ICONS[x.sport]} {x.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          <Link href={`/venue/${x.venueId}`} className="underline">
            {x.venueName}
          </Link>{" "}
          · {t("tour.when", { from: x.startsOn, to: x.endsOn, start: formatHour(x.startHour), end: formatHour(x.endHour) })}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {x.teamSize === 2 ? t("tour.doubles") : t("tour.singles")} · {x.format === "groups" ? t("tour.groups") : t("tour.knockout")}
          {x.level && ` · ${t(`games.level.${x.level}`)}`} · {x.entryFee > 0 ? t("tour.fee", { amount: x.entryFee.toFixed(2) }) : t("tour.free")} ·{" "}
          {t(`tour.status.${x.status}`)}
        </p>
        {x.description && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{x.description}</p>}
        {champion && <p className="mt-3 text-lg font-bold text-teal-700">🏆 {t("tour.champion", { name: champion })}</p>}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      <EnterBox t={t} x={x} mine={data.mine} signedIn={data.signedIn} partner={partner} setPartner={setPartner} act={act} />

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
                    <th className="w-8 font-medium">{t("tour.lost")}</th>
                    <th className="w-12 font-medium">{t("tour.sets")}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.table.map((s, i) => (
                    <tr key={s.entryId} className={i < x.advance ? "font-medium" : "text-slate-600"}>
                      <td className="py-0.5">{names.get(s.entryId)}</td>
                      <td className="text-center">{s.played}</td>
                      <td className="text-center">{s.won}</td>
                      <td className="text-center">{s.lost}</td>
                      <td className="text-center">
                        {s.setDiff > 0 ? "+" : ""}
                        {s.setDiff}
                      </td>
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
              .filter((m) => m.status !== "bye" && m.date)
              .sort((a, b) => `${a.date}${String(a.hour).padStart(2, "0")}`.localeCompare(`${b.date}${String(b.hour).padStart(2, "0")}`))
              .map((m) => (
                <li key={m.id} className="flex flex-wrap gap-x-3 py-1.5">
                  <span className="w-36 shrink-0 text-slate-500">
                    {m.date} {formatHour(m.hour!)}, {m.courtName}
                  </span>
                  <span className="flex-1">
                    <Side id={m.a} m={m} names={names} t={t} /> v <Side id={m.b} m={m} names={names} t={t} />
                  </span>
                  <span className="text-slate-600">{m.status === "walkover" ? t("tour.walkover") : m.score}</span>
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
              .sort((a, b) => a.position - b.position)
              .map((m) => (
                <div key={m.id} className="rounded-lg border border-slate-200 text-sm">
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
                  {(m.score || m.status === "walkover") && (
                    <div className="px-2 pb-1 text-xs text-slate-500">{m.status === "walkover" ? t("tour.walkover") : m.score}</div>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function EnterBox({
  t,
  x,
  mine,
  signedIn,
  partner,
  setPartner,
  act,
}: {
  t: T;
  x: TournamentDetail;
  mine: Entry | null;
  signedIn: boolean;
  partner: string;
  setPartner: (p: string) => void;
  act: (body: object) => Promise<void>;
}) {
  const button = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";
  if (mine)
    return (
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm">
        <span className="font-medium text-teal-900">{mine.status === "waitlisted" ? t("tour.youWait") : t("tour.youreIn")}: {mine.name}</span>
        <span className="flex flex-wrap items-center gap-3">
          {mine.status === "entered" && x.entryFee > 0 &&
            (mine.paid ? (
              <span className="font-semibold text-emerald-700">{t("tour.feePaid")}</span>
            ) : x.payOnline ? (
              <button onClick={() => void act({ action: "pay" })} className={button}>
                {t("tour.payFee", { amount: x.entryFee.toFixed(2) })}
              </button>
            ) : (
              <span>{t("tour.payAtVenue", { amount: x.entryFee.toFixed(2) })}</span>
            ))}
          {(x.status === "open" || x.status === "closed") && (
            <button onClick={() => void act({ action: "withdraw" })} className="text-slate-600 underline">
              {t("tour.withdraw")}
            </button>
          )}
        </span>
      </section>
    );
  if (x.status !== "open") return null;
  if (!signedIn)
    return (
      <Link href={`/login?next=/tournaments/${x.id}`} className={`inline-block ${button}`}>
        {t("tour.signInToEnter")}
      </Link>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void act({ action: "enter", partnerName: partner });
      }}
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      {x.teamSize === 2 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("tour.partner")}
          <input
            required
            minLength={2}
            value={partner}
            onChange={(e) => setPartner(e.target.value)}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>
      )}
      <button className={button}>{t("tour.enter")}</button>
      <span className="text-sm text-slate-500">
        {t("tour.entries", { entered: x.entered, max: x.maxEntries })}
        {x.waitlisted > 0 && ` · ${t("tour.waiting", { n: x.waitlisted })}`}
      </span>
    </form>
  );
}
