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
import type { OfficialPerformanceView } from "@/lib/official-performances";
import type { Match, TournamentDetail } from "@/lib/tournaments";
import { CountedGridCore, type GridKey } from "@/components/admin/CountedGrid";
import type { DayBoard, DayFixture } from "@/lib/tournament-day";

/**
 * An official's page: the link the venue gave them is the key, no account
 * needed. The tournament's matches waiting for a result, in time order, each
 * with a result form; what they enter is recorded with their name.
 */
export default function OfficialPage() {
  const t = useT();
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<{ official: Official; tournament: TournamentDetail; day?: DayBoard | null; performance?: OfficialPerformanceView } | null>(null);
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
      {data.performance ? (
        <ClimbingRounds
          t={t}
          token={token}
          data={{ official: data.official, tournament: data.tournament, performance: data.performance }}
          patch={(p) => setData((d) => (d ? { ...d, ...(p.tournament ? { tournament: p.tournament } : {}), ...(p.performance ? { performance: p.performance } : {}) } : d))}
          setError={setError}
          setNotice={setNotice}
        />
      ) : waiting.length === 0 ? (
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

const small = "rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:border-teal-500";
const field = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

/**
 * A climbing event's rounds for an official (docs/features/tournaments.md#officials-and-counted-results): the counts of each round still open, entered
 * as a judge does at the wall; a finalised or advanced round is read-only, with a correction request (why, and the counts it should have) for the
 * organiser to review; and their own recent entries and requests. Nothing else is offered: the link is for this event's counts.
 */
function ClimbingRounds({
  t,
  token,
  data,
  patch,
  setError,
  setNotice,
}: {
  t: ReturnType<typeof useT>;
  token: string;
  data: { official: Official; tournament: TournamentDetail; performance: OfficialPerformanceView };
  patch: (p: { tournament?: TournamentDetail; performance?: OfficialPerformanceView }) => void;
  setError: (e: string | null) => void;
  setNotice: (n: string | null) => void;
}) {
  const x = data.tournament;
  const names = new Map(x.entries.map((e) => [e.id, e.name]));
  const words = (key: GridKey, vars?: Record<string, string | number>) => t(`ofc1.cg.${key}`, vars);
  const rounds = x.matches.filter((m): m is Match => m.stage === "heat" || m.stage === "final").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.minute ?? 0) - (b.minute ?? 0) || a.id - b.id);

  async function send(body: object): Promise<boolean> {
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/officials/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await readJson(res);
    if (!res.ok) {
      setError(translateError(t, out) || out.error);
      return false;
    }
    patch({ tournament: out.tournament, performance: out.performance });
    return true;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t("ofc1.of.intro")}</p>
      {rounds.length === 0 && <p className="text-sm text-slate-500">{t("official.none")}</p>}
      {rounds.map((m) => {
        const lines = x.performance?.lines[m.id] ?? [];
        const lock = data.performance.rounds.find((r) => r.matchId === m.id)?.lock ?? null;
        const heading = m.stage === "final" ? t("ofc1.cg.final") : t("ofc1.cg.group", { n: m.position });
        if (lines.length === 0) return <CountedGridCore key={m.id} tn={x} m={m} lines={lines} names={names} t={words} locale={t.locale} onSave={async () => undefined} />;
        if (lock === null)
          return (
            <CountedGridCore
              key={`${m.id}:${lines.map((l) => `${l.entryId}${l.status}${l.shown ?? ""}`).join(",")}`}
              tn={x}
              m={m}
              lines={lines}
              names={names}
              t={words}
              locale={t.locale}
              onSave={async (performances) => {
                if (await send({ matchId: m.id, performances })) setNotice(t("official.saved"));
              }}
            />
          );
        return (
          <CorrectionAsk key={m.id} t={t} heading={heading} lock={lock} m={m} lines={lines} names={names} x={x} words={words} send={send} />
        );
      })}

      {data.performance.requests.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
          <h2 className="font-semibold">{t("ofc1.of.requests")}</h2>
          <ul className="mt-1 space-y-1">
            {data.performance.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {t("ofc1.of.requestLine", { round: roundName(t, rounds, r.matchId), reason: r.reason })} · {t(`ofc1.of.req.${r.status}`)}
                  {r.status === "declined" && r.decisionNote ? `: ${r.decisionNote}` : ""}
                </span>
                {r.status === "open" && (
                  <button className={small} onClick={() => void send({ action: "correction_withdraw", requestId: r.id })}>
                    {t("ofc1.of.withdraw")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.performance.recent.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
          <h2 className="font-semibold">{t("ofc1.of.recent")}</h2>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
            {data.performance.recent.map((r, i) => (
              <li key={i}>
                {roundName(t, rounds, r.matchId)}: {r.entry} · {r.now ?? "-"}
                {r.was !== null && ` (${t("ofc1.of.was", { was: r.was })})`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function roundName(t: ReturnType<typeof useT>, rounds: Match[], matchId: number): string {
  const m = rounds.find((r) => r.id === matchId);
  return !m ? "" : m.stage === "final" ? t("ofc1.cg.final") : t("ofc1.cg.group", { n: m.position });
}

/** A finalised or advanced round: its results as they stand, and the way to ask for them to be corrected. */
function CorrectionAsk({
  t,
  heading,
  lock,
  m,
  lines,
  names,
  x,
  words,
  send,
}: {
  t: ReturnType<typeof useT>;
  heading: string;
  lock: "finalised" | "advanced";
  m: Match;
  lines: NonNullable<TournamentDetail["performance"]>["lines"][number];
  names: Map<number, string>;
  x: TournamentDetail;
  words: (key: GridKey, vars?: Record<string, string | number>) => string;
  send: (body: object) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <h2 className="font-semibold">
        {heading} <span className="text-xs font-normal text-slate-500">· {t(lock === "advanced" ? "ofc1.of.advanced" : "ofc1.of.finalised")}</span>
      </h2>
      <ol className="mt-1 space-y-0.5 text-xs text-slate-700">
        {lines
          .slice()
          .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.lane - b.lane)
          .map((l) => (
            <li key={l.entryId}>
              {l.rank ?? "-"} · {names.get(l.entryId)} · {l.shown ?? l.status}
            </li>
          ))}
      </ol>
      <p className="mt-2 text-xs text-slate-600">{t("ofc1.of.finalNote")}</p>
      <button className={`${small} mt-1`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("ofc1.of.askCorrection")}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("ofc1.of.reason")}
            <textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className={field} />
          </label>
          <CountedGridCore
            tn={x}
            m={m}
            lines={lines}
            names={names}
            t={words}
            locale={t.locale}
            saveLabel={t("ofc1.of.sendCorrection")}
            onSave={async (performances) => {
              if (await send({ action: "correction_request", matchId: m.id, reason, performances })) {
                setOpen(false);
                setReason("");
              }
            }}
          />
        </div>
      )}
    </section>
  );
}
