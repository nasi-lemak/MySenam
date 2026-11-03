"use client";

import { readJson } from "@/lib/read-response";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { MatchResultForm } from "@/components/MatchResultForm";
import { translateError } from "@/lib/i18n";
import { formatMinute } from "@/lib/interval";
import { scoreExample } from "@/lib/result-text";
import type { Official } from "@/lib/match-reports";
import type { TournamentDetail } from "@/lib/tournaments";
import type { DayBoard, DayFixture } from "@/lib/tournament-day";

/**
 * An official's page: the link the venue gave them is the key, no account
 * needed. The tournament's matches waiting for a result, in time order, each
 * with a result form; what they enter is recorded with their name.
 */
export default function OfficialPage() {
  const t = useT();
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<{ official: Official; tournament: TournamentDetail; day?: DayBoard | null } | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/officials/${token}`, { cache: "no-store" });
    if (!res.ok) return setGone(true);
    setData(await readJson(res));
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  if (gone) return <p className="text-slate-600">{t("official.gone")}</p>;
  if (!data) return null;
  const x = data.tournament;
  const names = new Map(x.entries.map((e) => [e.id, e.name]));
  const waiting = x.matches
    .filter((m) => m.status === "scheduled" && m.a !== null && m.b !== null && (m.stage === "group" || m.stage === "knockout"))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.minute ?? 0) - (b.minute ?? 0));
  const fixtures = new Map<number, DayFixture>([...(data.day?.waiting ?? []), ...(data.day?.courts ?? []).flatMap((c) => (c.now ? [c.now] : []))].map((f) => [f.id, f]));
  /** Call the players, mark the match started, or take the call back, where the match is held (bringing one forward is a manager's). */
  async function day(matchId: number, action: "call" | "start" | "release") {
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/officials/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matchId, action }) });
    const out = await readJson(res);
    if (!res.ok) return setError(translateError(t, out) || out.error);
    setData((d) => (d ? { ...d, day: out.day } : d));
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("official.title", { name: x.name })}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {x.venueName} · {t("official.as", { name: data.official.name })}
        </p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>}
      {waiting.length === 0 ? (
        <p className="text-sm text-slate-500">{t("official.none")}</p>
      ) : (
        <ul className="space-y-3">
          {waiting.map((m) => (
            <li key={m.id} className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
              <div className="text-slate-500">
                {m.date} {m.minute !== null ? formatMinute(m.minute, t.locale) : ""}, {m.courtName}
              </div>
              <div className="font-medium">
                {names.get(m.a!)} v {names.get(m.b!)}
              </div>
              {fixtures.get(m.id) && (
                <div className="my-2 flex flex-wrap items-center gap-2">
                  {fixtures.get(m.id)!.state === "waiting" ? (
                    <button type="button" onClick={() => void day(m.id, "call")} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium">
                      {t("dy1.official.call")}
                    </button>
                  ) : (
                    <>
                      <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${fixtures.get(m.id)!.state === "playing" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>
                        {fixtures.get(m.id)!.state === "playing" ? t("dy1.live.playing") : t("dy1.live.called")}
                      </span>
                      {fixtures.get(m.id)!.state === "called" && (
                        <>
                          <span className="text-xs text-slate-600">{fixtures.get(m.id)!.overdue ? t("dy1.official.over") : t("dy1.official.timer", { n: fixtures.get(m.id)!.minutesLeft })}</span>
                          <button type="button" onClick={() => void day(m.id, "start")} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium">
                            {t("dy1.official.start")}
                          </button>
                        </>
                      )}
                      <button type="button" onClick={() => void day(m.id, "release")} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium">
                        {t("dy1.official.release")}
                      </button>
                    </>
                  )}
                </div>
              )}
              <MatchResultForm
                t={t}
                sides={{ a: { id: m.a!, name: names.get(m.a!) ?? "" }, b: { id: m.b!, name: names.get(m.b!) ?? "" } }}
                drawAllowed={x.rules.scoring.kind === "tally" && x.rules.scoring.draws && m.stage === "group"}
                scoreHint={scoreExample(x)}
                onSubmit={async (r) => {
                  setError(null);
                  setNotice(null);
                  const res = await fetch(`/api/officials/${token}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ matchId: m.id, ...r }),
                  });
                  const out = await readJson(res);
                  if (!res.ok) return setError(translateError(t, out) || out.error);
                  setNotice(t("official.saved"));
                  setData({ ...data, tournament: out.tournament });
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
