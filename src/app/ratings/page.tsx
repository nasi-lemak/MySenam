"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { sportLabel, type T } from "@/lib/i18n";
import { shortDate } from "@/lib/region";
import type { HistoryLine, MyPool, MyRatings } from "@/lib/ratings";

type Rules = { start: number; provisionalGames: number };
type Who = { key: string; query: string };

const pad = (n: number) => (n > 0 ? `+${n}` : String(n));

/** One result, explained: who, what the rating expected, what happened, how far it moved (lib/ratings.ts `ratingHistory`). */
function HistoryItem({ t, line }: { t: T; line: HistoryLine }) {
  const opp = line.opponents.map((o) => (o.junior ? t("rt.junior") : o.label || t("rt.removed"))).join(" / ") || t("rt.removed");
  return (
    <li className="space-y-0.5 py-2 text-sm">
      <div className="font-medium">
        {shortDate(line.playedOn, t.locale)}, {line.eventName}: {t(`rt.res.${line.result}`, { opp })}
      </div>
      {line.excluded ? (
        <div className="text-slate-500">{t("rt.why.excluded")}</div>
      ) : line.counted && line.ratingBefore !== null && line.ratingAfter !== null && line.change !== null ? (
        <div className="text-slate-600">
          {t(line.expectedExact ? "rt.why.exact" : "rt.why.approx", { before: Math.round(line.ratingBefore), expected: line.expected ?? 0, change: pad(Math.round(line.change * 10) / 10), after: Math.round(line.ratingAfter), k: line.k ?? 0 })}
          {line.kind === "retired" && ` ${t("rt.why.retired")}`}
          {line.marginFactor !== null && line.marginFactor > 1 && ` ${t("rt.why.margin", { factor: line.marginFactor })}`}
          {line.opponentRating !== null ? ` ${t("rt.why.theirs", { theirs: Math.round(line.opponentRating) })}` : ` ${t("rt.why.private")}`}
        </div>
      ) : (
        <div className="text-slate-500">{t(line.kind === "walkover" ? "rt.why.walkover" : "rt.why.none")}</div>
      )}
      {line.beforeReset && <div className="text-xs text-slate-500">{t("rt.why.reset")}</div>}
    </li>
  );
}

function Pool({ t, pool, who, rules }: { t: T; pool: MyPool; who: Who; rules: Rules }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<HistoryLine[] | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`/api/my/ratings?venueId=${pool.venueId}&sport=${pool.sport}&format=${pool.format}${who.query}`, { cache: "no-store" });
    if (res.ok) setLines((await readJson(res)).history);
  }, [pool, who.query]);
  const toggle = () => {
    if (!open && lines === null) void load();
    setOpen(!open);
  };
  return (
    <li className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm" data-testid="rating-pool">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-semibold">
          {sportLabel(t, pool.sport)}, {t(`rt.format.${pool.format}`)} <span className="font-normal text-slate-500">{t("rt.at", { venue: pool.venueName })}</span>
        </div>
        <div className="text-xl font-bold tabular-nums" aria-label={t("rt.rating")}>
          {pool.rating}
        </div>
      </div>
      <div className="text-slate-600">
        {pool.provisional
          ? t("rt.provisional", { n: Math.max(0, (pool.rankAfter ?? rules.provisionalGames) - pool.games) })
          : pool.earns && t("rt.earns", { level: t(`games.level.${pool.earns}`) })}{" "}
        · {t("rt.record", { w: pool.wins, d: pool.draws, l: pool.losses })}
        {pool.form.length > 0 && (
          <span>
            {" "}
            · {t("rt.form")}: <span className="font-mono tracking-widest">{pool.form.join("")}</span>
          </span>
        )}
      </div>
      <button type="button" onClick={toggle} aria-expanded={open} className="rounded-md border border-slate-300 px-2 py-0.5 text-xs hover:border-teal-500">
        {open ? t("rt.hide") : t("rt.show")}
      </button>
      {open && (lines === null ? null : lines.length === 0 ? <p className="text-slate-500">{t("rt.hist.none")}</p> : <ul className="divide-y divide-slate-100">{lines.map((l) => <HistoryItem key={l.resultId} t={t} line={l} />)}</ul>)}
    </li>
  );
}

/** The player's own ratings, a child's they act for, and their teams', each with how every result moved it (lib/ratings.ts). */
export default function RatingsPage() {
  const t = useT();
  const [data, setData] = useState<{ ratings: MyRatings; rules: Rules } | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/my/ratings", { cache: "no-store" });
      if (res.status === 401) return setSignedOut(true);
      setData(await readJson(res));
    })();
  }, []);
  if (signedOut)
    return (
      <Link href="/login?next=/ratings" className="text-teal-700 underline">
        {t("rt.signIn")}
      </Link>
    );
  if (!data) return null;
  const { ratings, rules } = data;
  const empty = ratings.who.every((w) => w.pools.length === 0) && ratings.teams.length === 0;
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("rt.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("rt.intro", { start: rules.start, n: rules.provisionalGames })}</p>
        <p className="mt-1 text-sm text-slate-600">{t("rk1.note", { n: rules.provisionalGames })} {t("rk1.venueSets", { n: rules.provisionalGames })}</p>
        <p className="mt-1 text-sm">
          <Link href="/games/preferences" className="text-teal-700 underline">
            {t("rt.preferences")}
          </Link>
        </p>
      </div>
      {empty && <p className="text-sm text-slate-500">{t("rt.none")}</p>}
      {ratings.who.map((w) =>
        w.pools.length === 0 ? null : (
          <section key={w.participantId ?? "me"} className="space-y-2">
            {w.name && <h2 className="font-semibold">{t("rt.for", { name: w.name })}</h2>}
            <ul className="space-y-2">
              {w.pools.map((p) => (
                <Pool key={`${p.venueId}${p.sport}${p.format}`} t={t} pool={p} rules={rules} who={{ key: String(w.participantId ?? "me"), query: w.participantId ? `&participantId=${w.participantId}` : "" }} />
              ))}
            </ul>
          </section>
        )
      )}
      {ratings.teams.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">{t("rt.teams")}</h2>
          {ratings.teams.map((team) => (
            <div key={team.teamId} className="space-y-2">
              <h3 className="text-sm font-medium text-slate-700">{team.name}</h3>
              <ul className="space-y-2">
                {team.pools.map((p) => (
                  <Pool key={`${team.teamId}${p.venueId}${p.sport}${p.format}`} t={t} pool={p} rules={rules} who={{ key: `t${team.teamId}`, query: `&teamId=${team.teamId}` }} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
