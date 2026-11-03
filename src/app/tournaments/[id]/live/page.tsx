"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { ActivityGlyph } from "@/components/Glyph";
import { formatMinute } from "@/lib/interval";
import type { T } from "@/lib/i18n";
import type { LiveBoard, LiveFixture } from "@/lib/tournament-day";

/**
 * A tournament's live board for anybody, no sign-in: what is on each court,
 * what is next, and the latest results, refreshing by itself (lib/tournament-day.ts
 * `liveBoard`). Names are as the public may see them: a declared minor by first
 * name and initial. Made to be read on a phone, or put on a screen.
 */

function labelOf(t: T, f: { stage: LiveFixture["stage"]; groupNo: number | null; round: number; placement: 3 | null; rounds: number }): string {
  // `rounds` is -1 for a Swiss event: its matches are the rounds of its group stage.
  if (f.stage === "group") return f.rounds < 0 ? t("swiss.ui.round", { n: f.round }) : t("tour.group", { n: f.groupNo ?? 0 });
  if (f.placement === 3) return t("tour.thirdPlace");
  if (f.round === f.rounds) return t("tour.final");
  if (f.round === f.rounds - 1) return t("tour.semis");
  if (f.round === f.rounds - 2) return t("tour.quarters");
  return t("tour.round", { n: f.round });
}

export default function LiveTournamentPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [board, setBoard] = useState<LiveBoard | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tournaments/${id}/live`, { cache: "no-store" });
      if (res.status === 404) return setMissing(true);
      if (!res.ok) throw new Error("load");
      setBoard((await readJson(res)).board);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);
  useEffect(() => {
    void load();
    // Results and calls come in while it is on.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (missing) return <p className="text-slate-500">{t("tour.none")}</p>;
  if (!board) return failed ? <p role="alert" className="text-sm text-red-700">{t("dy1.live.retry")}</p> : null;

  const side = (name: string | null) => name ?? t("dy1.live.tbd");
  const when = (f: LiveFixture) => (f.minute === null ? "" : f.date === board.today ? formatMinute(f.minute, t.locale) : t("dy1.live.at", { date: f.date ?? "", time: formatMinute(f.minute, t.locale) }));
  const fixture = (f: LiveFixture) => (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{labelOf(t, f)}</div>
      <div className="text-base font-medium">
        {side(f.a)} <span className="font-normal text-slate-400">v</span> {side(f.b)}
      </div>
    </div>
  );
  const drawn = board.courts.some((c) => c.now || c.next) || board.recent.length > 0;

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/tournaments/${board.id}`} className="text-sm text-teal-700 underline">
          ← {t("dy1.live.back")}
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          <ActivityGlyph sport={board.sport} /> {t("dy1.live.title", { name: board.name })}
        </h1>
        <p className="mt-1 text-sm text-slate-600">{board.venueName}</p>
        <p className="mt-1 text-xs text-slate-500">{t("dy1.live.refreshes")}</p>
        {failed && (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {t("dy1.live.retry")}
          </p>
        )}
      </div>

      {board.status === "finished" && <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{t("dy1.live.over")}</p>}
      {(board.status === "open" || board.status === "closed") && <p className="text-sm text-slate-600">{t("dy1.live.notDrawn")}</p>}

      {drawn && (
        <div className="grid gap-3 sm:grid-cols-2">
          {board.courts.map((c) => (
            <section key={c.id} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label={c.name}>
              <h2 className="text-lg font-bold">{c.name}</h2>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-teal-700">{t("dy1.live.now")}</div>
                {c.now ? (
                  <>
                    {fixture(c.now)}
                    <div className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-semibold ${c.now.state === "playing" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>
                      {c.now.state === "playing" ? t("dy1.live.playing") : t("dy1.live.called")}
                    </div>
                  </>
                ) : (
                  <div className="text-slate-500">{t("dy1.live.free")}</div>
                )}
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("dy1.live.next")}</div>
                {c.next ? (
                  <>
                    {fixture(c.next)}
                    <div className="text-sm text-slate-600">{when(c.next)}</div>
                  </>
                ) : (
                  <div className="text-sm text-slate-500">{t("dy1.live.nothingNext")}</div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      <section>
        <h2 className="text-lg font-bold">{t("dy1.live.recent")}</h2>
        {board.recent.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">{t("dy1.live.noResults")}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {board.recent.map((r) => (
              <li key={r.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{labelOf(t, r)}</div>
                <div>
                  {side(r.a)} <span className="text-slate-400">v</span> {side(r.b)}
                </div>
                <div className="text-slate-600">
                  {r.winner ? t("dy1.live.won", { name: r.winner }) : ""}
                  {r.walkover ? ` (${t("tour.walkover")})` : r.score ? ` · ${r.score}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
